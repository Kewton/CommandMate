/**
 * The Auto-Yes confirmation ledger (Issue #3820): one record per confirmation —
 * what Auto-Yes decided about it, each send and how it came back, how it went
 * away — and the intervals Auto-Yes left it alone, written as structured log
 * lines for agent-health's daily count (design
 * `docs/design/auto-yes-measurement-3820.md`, PR 1: the screen path).
 *
 * ## Records, never decides
 *
 * Nothing in the poller reads this to choose what to do: every entry point is
 * called after the poller decided, and none of them can throw. A failure here —
 * the ledger's own or its logger's — is counted (`ledgerErrors` on the hourly
 * `alive` line) and swallowed; the `catch` calls nothing that can throw in turn
 * (design §8.1). What is promised is "an exception in the ledger never fails an
 * answer", not that writing a line costs nothing: the logger writes to the
 * console synchronously.
 *
 * ## Two axes (design §2.2)
 *
 * A confirmation is `present` or `unobservable` (the poller stopped: Auto-Yes
 * off, expired, …) while it is open; it closes when a tick that read the screen
 * did not see it (`gone`), or when the session it was on ended (`abandoned`).
 * Whether Auto-Yes may answer it is the other axis: a withheld interval opens
 * at the first withholding and runs, through reason changes, until an `ok`
 * send, the confirmation going away, or the poller stopping. agy's receipt
 * window flips the gated reading to `isPrompt: false` while the dialog stays
 * up; the poller observes it from the ungated reading instead, so it stays one
 * confirmation and one interval.
 *
 * ## State
 *
 * One `globalThis` object (`bootId`, the entries, the counters, the clock), so
 * a second bundle or a hot reload continues the same `bootId` and the same
 * sequence; only a new process starts another (design §3.3, recommendation 7).
 * The hourly clock (`alive` and `checkpoint` lines on the UTC hour grid) is
 * armed the first time the ledger is used — `server.ts` is not touched — and is
 * `unref`ed so it never holds the process open.
 *
 * Server only (logger, `node:crypto`). Must not import `auto-yes-poller.ts`.
 *
 * @module lib/polling/auto-yes-confirmation-ledger
 */

import { randomUUID } from 'node:crypto';
import type { CLIToolType } from '../cli-tools/types';
import { createLogger, type Logger } from '@/lib/logger';
import { getLogConfig } from '@/lib/env';
import { buildCompositeKey } from '../auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import { getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback-state';
import {
  AUTO_YES_LEDGER_EVENTS,
  AUTO_YES_LEDGER_LOG_MODULE,
  AUTO_YES_LEDGER_VERSION,
  type AnswerBasis,
  type AttemptCounts,
  type AttemptResult,
  type AttemptSettledLine,
  type AutoYesLedgerPath,
  type CheckpointLine,
  type ConfirmationClosedLine,
  type ConfirmationDecision,
  type ConfirmationOpenedLine,
  type ConfirmationResolution,
  type ConfirmationSource,
  type LedgerAliveLine,
  type LedgerLineBase,
  type LedgerStartedLine,
  type LedgerWithholdReason,
  type PresenceChangedLine,
  type WithholdEnd,
  type WithholdEndedLine,
  type WithholdReasonChangedLine,
  type WithholdStartedLine,
} from './auto-yes-confirmation-ledger-types';

/** The paths this version records (PR 1: the poller's screen path only). */
export const AUTO_YES_LEDGER_RECORDED_PATHS: readonly AutoYesLedgerPath[] = ['screen'];

/** The grid of the `alive` and `checkpoint` lines: every UTC hour boundary. */
export const AUTO_YES_LEDGER_CLOCK_MS = 60 * 60 * 1000;

/** An `unobservable` confirmation is let go after this long (design §4.2). */
export const AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Open confirmations one instance may hold; the oldest goes past it (design §8.2). */
export const AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE = 16;

/** Open confirmations the process may hold; the oldest goes past it (design §8.2). */
export const AUTO_YES_LEDGER_MAX_OPEN_TOTAL = 1024;

/** Sends whose result has not come back that are remembered; the oldest is dropped past it. */
const MAX_PENDING_ATTEMPTS = 1024;

/**
 * Poller stop reasons that end the session the confirmation was on, or hand
 * the key to something else (design §4.2). Every other reason — off, expired,
 * the stop pattern, errors, a shutdown — only stops looking.
 */
const ABANDONING_STOP_REASONS: ReadonlySet<string> = new Set([
  'invalid-key',
  'session-killed',
  'instance-removed',
  'worktree-deleted',
  'orphan-swept',
  'worktree-id-migrated',
  'replaced',
  'reset',
]);

/** Which instance a call is about; `compositeKey` is built from the ids when omitted. */
export interface LedgerScope {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
  compositeKey?: string;
}

/**
 * One send's place in the ledger, taken before the send's first await and
 * kept by the caller with the send (design §2.5): the result goes to this
 * confirmation whatever happened to the screen or the key meanwhile.
 */
export interface LedgerAttemptHandle {
  readonly confirmationId: string;
  readonly attemptId: string;
}

interface OpenInterval {
  id: string;
  startedAt: number;
  reason: LedgerWithholdReason;
}

interface LedgerEntry {
  id: string;
  compositeKey: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  source: ConfirmationSource;
  /** What tells this confirmation from the next on the same screen (`partialAnswerScreenKey`). Memory only. */
  screenKey: string;
  epoch: number;
  promptType: string;
  openedAt: number;
  presence: 'present' | 'unobservable';
  unobservableSince: number | null;
  unobservableMs: number;
  decision: ConfirmationDecision;
  basis: AnswerBasis | null;
  interval: OpenInterval | null;
  intervals: number;
  withheldMsClosed: number;
  attempts: AttemptCounts;
  nextAttempt: number;
  answered: boolean;
  /** The ledger tick that last saw it on screen. */
  observedTick: number;
}

interface PendingAttempt {
  confirmationId: string;
  cliToolId: CLIToolType;
  basis: AnswerBasis;
  receiptAccepted: boolean;
}

interface LedgerClock {
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number;
}

interface LedgerState {
  bootId: string;
  startedAt: number;
  nextConfirmation: number;
  /** Insertion order is age: the first is the oldest (capacity). */
  entries: Map<string, LedgerEntry>;
  /** compositeKey -> the screen confirmation of that instance. */
  current: Map<string, string>;
  /** compositeKey -> the ledger tick in progress. */
  ticks: Map<string, number>;
  nextTick: number;
  pending: Map<string, PendingAttempt>;
  errors: number;
  lastAliveAt: number | null;
  clock: LedgerClock | null;
}

declare global {
  // eslint-disable-next-line no-var
  var __autoYesConfirmationLedger: LedgerState | undefined;
}

interface ClockTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * The clock's timers, taken when the module loads. The hourly clock is not one
 * of the poller's timers, so a test that fakes timers around the poller (and
 * counts them) neither sees nor runs it. Tests of the clock itself replace them
 * with {@link setAutoYesLedgerClockTimersForTests}.
 */
const loadedClockTimers: ClockTimers = {
  setTimeout: globalThis.setTimeout.bind(globalThis) as ClockTimers['setTimeout'],
  clearTimeout: globalThis.clearTimeout.bind(globalThis) as ClockTimers['clearTimeout'],
};
let clockTimers: ClockTimers = loadedClockTimers;

/** Test seam: when set, every entry point fails as if its body had thrown. */
let injectedFault: Error | null = null;

let cachedLogger: Logger | null = null;
function ledgerLogger(): Logger {
  cachedLogger ??= createLogger(AUTO_YES_LEDGER_LOG_MODULE);
  return cachedLogger;
}

function currentLogLevel(): string {
  try {
    return getLogConfig().level;
  } catch {
    return 'unknown';
  }
}

type LineFields<T extends LedgerLineBase> = Omit<T, 'ledgerVersion' | 'bootId'>;

/** Write one line. A logger that throws is counted, never passed on. */
function emit<T extends LedgerLineBase>(state: LedgerState, event: string, fields: LineFields<T>): void {
  try {
    ledgerLogger().info(event, { ledgerVersion: AUTO_YES_LEDGER_VERSION, bootId: state.bootId, ...fields });
  } catch {
    state.errors += 1;
  }
}

function ledgerState(): LedgerState {
  const existing = globalThis.__autoYesConfirmationLedger;
  if (existing !== undefined) return existing;
  const state = getOrInitGlobal('__autoYesConfirmationLedger', () => {
    const startedAt = Date.now();
    return {
      bootId: randomUUID().slice(0, 8),
      startedAt,
      nextConfirmation: 0,
      entries: new Map(),
      current: new Map(),
      ticks: new Map(),
      nextTick: 0,
      pending: new Map(),
      errors: 0,
      lastAliveAt: null,
      clock: null,
    };
  });
  emit<LedgerStartedLine>(state, AUTO_YES_LEDGER_EVENTS.started, {
    atMs: state.startedAt,
    logLevel: currentLogLevel(),
    paths: [...AUTO_YES_LEDGER_RECORDED_PATHS],
  });
  return state;
}

/**
 * Run `body` on the ledger's state, arming the clock first. Whatever throws —
 * the body, the state, the clock — is counted and `fallback` returned; the
 * counting itself cannot throw.
 */
function guarded<T>(fallback: T, body: (state: LedgerState, now: number) => T): T {
  try {
    if (injectedFault !== null) throw injectedFault;
    const state = ledgerState();
    ensureClock(state);
    return body(state, Date.now());
  } catch {
    const state = globalThis.__autoYesConfirmationLedger;
    if (state !== undefined) state.errors += 1;
    return fallback;
  }
}

function keyOf(scope: LedgerScope): string {
  return scope.compositeKey ?? buildCompositeKey(scope.worktreeId, scope.cliToolId, scope.instanceId);
}

function currentEntry(state: LedgerState, compositeKey: string): LedgerEntry | undefined {
  const id = state.current.get(compositeKey);
  return id === undefined ? undefined : state.entries.get(id);
}

// =============================================================================
// The clock: `alive` and `checkpoint` lines on the UTC hour grid (design §4.3, §4.4)
// =============================================================================

function ensureClock(state: LedgerState): void {
  if (state.clock !== null) return;
  scheduleClock(state, Date.now());
}

function scheduleClock(state: LedgerState, now: number): void {
  const dueAt = (Math.floor(now / AUTO_YES_LEDGER_CLOCK_MS) + 1) * AUTO_YES_LEDGER_CLOCK_MS;
  const clock: LedgerClock = { timer: null, dueAt };
  state.clock = clock;
  const timer = clockTimers.setTimeout(() => onClock(clock), Math.max(0, dueAt - now));
  (timer as { unref?: () => void }).unref?.();
  clock.timer = timer;
}

function onClock(clock: LedgerClock): void {
  const state = globalThis.__autoYesConfirmationLedger;
  // A reset (tests) or a newer clock replaced this one.
  if (state === undefined || state.clock !== clock) return;
  state.clock = null;
  try {
    if (injectedFault !== null) throw injectedFault;
    runHour(state, clock.dueAt);
  } catch {
    state.errors += 1;
  }
  try {
    scheduleClock(state, Date.now());
  } catch {
    state.errors += 1;
  }
}

/**
 * One hour boundary: let go of confirmations unobservable for too long, then
 * the `alive` line and a `checkpoint` per open confirmation, all stamped `at`.
 */
function runHour(state: LedgerState, at: number): void {
  for (const entry of [...state.entries.values()]) {
    if (
      entry.presence === 'unobservable' &&
      entry.unobservableSince !== null &&
      at - entry.unobservableSince >= AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS
    ) {
      closeEntry(state, entry, at, { kind: 'abandoned', reason: 'unobservable-timeout' });
    }
  }
  const segmentStart = state.lastAliveAt ?? state.startedAt;
  state.lastAliveAt = at;
  let openIntervals = 0;
  for (const entry of state.entries.values()) if (entry.interval !== null) openIntervals += 1;
  emit<LedgerAliveLine>(state, AUTO_YES_LEDGER_EVENTS.alive, {
    atMs: at,
    logLevel: currentLogLevel(),
    segments: AUTO_YES_LEDGER_RECORDED_PATHS.map((path) => ({ path, startMs: segmentStart, endMs: at })),
    openConfirmations: state.entries.size,
    openIntervals,
    ledgerErrors: state.errors,
  });
  for (const entry of state.entries.values()) {
    const interval = entry.interval;
    const intervalMs = interval === null ? 0 : Math.max(0, at - interval.startedAt);
    emit<CheckpointLine>(state, AUTO_YES_LEDGER_EVENTS.checkpoint, {
      atMs: at,
      confirmationId: entry.id,
      cliToolId: entry.cliToolId,
      source: entry.source,
      presence: entry.presence,
      answerability: interval === null ? 'answerable' : 'withheld',
      withheldMsTotal: entry.withheldMsClosed + intervalMs,
      ...(interval !== null
        ? { intervalId: interval.id, reason: interval.reason, intervalStartedAtMs: interval.startedAt, intervalMs }
        : {}),
    });
  }
}

// =============================================================================
// Intervals and closing
// =============================================================================

function withhold(state: LedgerState, entry: LedgerEntry, reason: LedgerWithholdReason, now: number): void {
  const interval = entry.interval;
  if (interval === null) {
    entry.intervals += 1;
    const opened: OpenInterval = { id: `${entry.id}#${entry.intervals}`, startedAt: now, reason };
    entry.interval = opened;
    emit<WithholdStartedLine>(state, AUTO_YES_LEDGER_EVENTS.withholdStarted, {
      atMs: now,
      confirmationId: entry.id,
      intervalId: opened.id,
      cliToolId: entry.cliToolId,
      source: entry.source,
      reason,
      startedAtMs: now,
    });
    return;
  }
  if (interval.reason === reason) return;
  emit<WithholdReasonChangedLine>(state, AUTO_YES_LEDGER_EVENTS.withholdReasonChanged, {
    atMs: now,
    confirmationId: entry.id,
    intervalId: interval.id,
    cliToolId: entry.cliToolId,
    source: entry.source,
    from: interval.reason,
    to: reason,
  });
  interval.reason = reason;
}

function endInterval(state: LedgerState, entry: LedgerEntry, end: WithholdEnd, now: number): void {
  const interval = entry.interval;
  if (interval === null) return;
  entry.interval = null;
  const withheldMs = Math.max(0, now - interval.startedAt);
  entry.withheldMsClosed += withheldMs;
  emit<WithholdEndedLine>(state, AUTO_YES_LEDGER_EVENTS.withholdEnded, {
    atMs: now,
    confirmationId: entry.id,
    intervalId: interval.id,
    cliToolId: entry.cliToolId,
    source: entry.source,
    startedAtMs: interval.startedAt,
    endedAtMs: now,
    withheldMs,
    end,
    lastReason: interval.reason,
  });
}

type CloseHow = { kind: 'gone' } | { kind: 'abandoned'; reason: string };

function closeEntry(state: LedgerState, entry: LedgerEntry, now: number, how: CloseHow): void {
  const wasUnobservable = entry.presence === 'unobservable';
  if (wasUnobservable && entry.unobservableSince !== null) {
    entry.unobservableMs += Math.max(0, now - entry.unobservableSince);
  }
  const withheldAtClose = entry.interval !== null;
  endInterval(state, entry, how.kind === 'gone' ? 'gone' : 'abandoned', now);
  let attemptsPending = 0;
  for (const pending of state.pending.values()) if (pending.confirmationId === entry.id) attemptsPending += 1;
  const sent = entry.nextAttempt > 0;
  let resolution: ConfirmationResolution;
  if (how.kind === 'abandoned') {
    resolution = sent ? 'unresolved-after-send' : 'abandoned';
  } else if (wasUnobservable) {
    resolution = 'gone-while-unobservable';
  } else if (withheldAtClose) {
    resolution = 'resolved-while-withheld';
  } else if (entry.answered) {
    resolution = 'resolved-after-answer';
  } else if (entry.intervals > 0) {
    resolution = 'resolved-while-withheld';
  } else {
    resolution = 'resolved-before-decision';
  }
  emit<ConfirmationClosedLine>(state, AUTO_YES_LEDGER_EVENTS.closed, {
    atMs: now,
    confirmationId: entry.id,
    worktreeId: entry.worktreeId,
    cliToolId: entry.cliToolId,
    instanceId: entry.instanceId,
    source: entry.source,
    promptType: entry.promptType,
    decision: entry.decision,
    basis: entry.basis,
    attempts: { ...entry.attempts },
    attemptsPending,
    answeredAtClose: entry.answered,
    resolution,
    // The screen path cannot tell Auto-Yes's keys from a human's (design §2.6).
    resolvedBy: 'unknown',
    openMs: Math.max(0, now - entry.openedAt),
    withheldMsTotal: entry.withheldMsClosed,
    unobservableMs: entry.unobservableMs,
    intervals: entry.intervals,
    ...(how.kind === 'abandoned' ? { abandonReason: how.reason } : {}),
  });
  state.entries.delete(entry.id);
  if (state.current.get(entry.compositeKey) === entry.id) state.current.delete(entry.compositeKey);
}

function makeRoom(state: LedgerState, compositeKey: string, now: number): void {
  const ofInstance = [...state.entries.values()].filter((entry) => entry.compositeKey === compositeKey);
  if (ofInstance.length >= AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE) {
    closeEntry(state, ofInstance[0], now, { kind: 'abandoned', reason: 'capacity' });
  }
  if (state.entries.size >= AUTO_YES_LEDGER_MAX_OPEN_TOTAL) {
    const oldest = state.entries.values().next().value;
    if (oldest !== undefined) closeEntry(state, oldest, now, { kind: 'abandoned', reason: 'capacity' });
  }
}

// =============================================================================
// The screen path (the poller)
// =============================================================================

/**
 * A poller tick that has read the screen begins. A confirmation from another
 * session of this instance (a relaunch the poller outlived) is abandoned.
 *
 * @returns The tick's token, for {@link endLedgerTick}
 */
export function beginLedgerTick(scope: LedgerScope): number {
  return guarded(0, (state, now) => {
    const compositeKey = keyOf(scope);
    state.nextTick += 1;
    const tick = state.nextTick;
    state.ticks.set(compositeKey, tick);
    const entry = currentEntry(state, compositeKey);
    if (entry !== undefined && entry.epoch !== getEnterFallbackSessionEpoch(compositeKey)) {
      closeEntry(state, entry, now, { kind: 'abandoned', reason: 'session-epoch-changed' });
    }
    return tick;
  });
}

/**
 * The tick is over: when it read the screen and saw no confirmation there —
 * neither the gated reading nor the ungated one — the open one is `gone`. A
 * newer tick for the same instance (a poller restarted meanwhile) decides
 * instead.
 */
export function endLedgerTick(scope: LedgerScope, tick: number): void {
  guarded(undefined, (state, now) => {
    const compositeKey = keyOf(scope);
    if (tick === 0 || state.ticks.get(compositeKey) !== tick) return;
    state.ticks.delete(compositeKey);
    const entry = currentEntry(state, compositeKey);
    if (entry !== undefined && entry.observedTick !== tick) closeEntry(state, entry, now, { kind: 'gone' });
  });
}

/**
 * The tick sees a confirmation on screen. The same screen key in the same
 * session continues the open one (back to `present` if it was unobservable);
 * anything else closes it as gone and opens a new one.
 *
 * @param screenKey - `partialAnswerScreenKey` of the prompt (kept in memory, never logged)
 */
export function observeLedgerScreen(scope: LedgerScope, screenKey: string, promptType: string): void {
  guarded(undefined, (state, now) => {
    const compositeKey = keyOf(scope);
    const epoch = getEnterFallbackSessionEpoch(compositeKey);
    const tick = state.ticks.get(compositeKey) ?? 0;
    let entry = currentEntry(state, compositeKey);
    if (entry !== undefined && (entry.screenKey !== screenKey || entry.epoch !== epoch)) {
      closeEntry(
        state,
        entry,
        now,
        entry.epoch !== epoch ? { kind: 'abandoned', reason: 'session-epoch-changed' } : { kind: 'gone' },
      );
      entry = undefined;
    }
    if (entry === undefined) {
      makeRoom(state, compositeKey, now);
      state.nextConfirmation += 1;
      const opened: LedgerEntry = {
        id: `${state.bootId}-${state.nextConfirmation}`,
        compositeKey,
        worktreeId: scope.worktreeId,
        cliToolId: scope.cliToolId,
        instanceId: scope.instanceId ?? scope.cliToolId,
        source: 'screen',
        screenKey,
        epoch,
        promptType,
        openedAt: now,
        presence: 'present',
        unobservableSince: null,
        unobservableMs: 0,
        decision: 'none',
        basis: null,
        interval: null,
        intervals: 0,
        withheldMsClosed: 0,
        attempts: { ok: 0, partial: 0, noKeysSent: 0, failed: 0 },
        nextAttempt: 0,
        answered: false,
        observedTick: tick,
      };
      state.entries.set(opened.id, opened);
      state.current.set(compositeKey, opened.id);
      emit<ConfirmationOpenedLine>(state, AUTO_YES_LEDGER_EVENTS.opened, {
        atMs: now,
        confirmationId: opened.id,
        worktreeId: opened.worktreeId,
        cliToolId: opened.cliToolId,
        instanceId: opened.instanceId,
        source: opened.source,
        promptType,
      });
      return;
    }
    if (entry.presence === 'unobservable') {
      if (entry.unobservableSince !== null) entry.unobservableMs += Math.max(0, now - entry.unobservableSince);
      entry.presence = 'present';
      entry.unobservableSince = null;
      emit<PresenceChangedLine>(state, AUTO_YES_LEDGER_EVENTS.presenceChanged, {
        atMs: now,
        confirmationId: entry.id,
        from: 'unobservable',
        to: 'present',
        cause: 'observed',
      });
    }
    entry.observedTick = tick;
  });
}

/**
 * Auto-Yes leaves the instance's current confirmation alone for `reason`:
 * opens a withheld interval, or records the reason changing inside one.
 */
export function withholdLedgerConfirmation(scope: LedgerScope, reason: LedgerWithholdReason): void {
  guarded(undefined, (state, now) => {
    const entry = currentEntry(state, keyOf(scope));
    if (entry === undefined || entry.presence !== 'present') return;
    entry.decision = 'withhold';
    withhold(state, entry, reason, now);
  });
}

/**
 * A send to the instance's current confirmation is about to begin. Called
 * before its first await; the handle goes with the send.
 *
 * @returns The handle, or null when there is no confirmation (or the ledger failed)
 */
export function beginLedgerAttempt(
  scope: LedgerScope,
  basis: AnswerBasis,
  options: { receiptAccepted?: boolean } = {},
): LedgerAttemptHandle | null {
  return guarded<LedgerAttemptHandle | null>(null, (state) => {
    const entry = currentEntry(state, keyOf(scope));
    if (entry === undefined) return null;
    entry.nextAttempt += 1;
    entry.decision = 'answer';
    entry.basis = basis;
    const handle: LedgerAttemptHandle = { confirmationId: entry.id, attemptId: `${entry.id}.${entry.nextAttempt}` };
    if (state.pending.size >= MAX_PENDING_ATTEMPTS) {
      const oldest = state.pending.keys().next().value;
      if (oldest !== undefined) state.pending.delete(oldest);
    }
    state.pending.set(handle.attemptId, {
      confirmationId: entry.id,
      cliToolId: entry.cliToolId,
      basis,
      receiptAccepted: options.receiptAccepted === true,
    });
    return handle;
  });
}

const WITHHOLD_REASON_OF_RESULT: Record<Exclude<AttemptResult, 'ok'>, LedgerWithholdReason> = {
  partial: 'partial-answer',
  'no-keys-sent': 'send-no-keys',
  failed: 'send-failed',
};

/**
 * A send came back. Its line belongs to the confirmation it was begun for,
 * open or not: one that closed meanwhile gets a `late` line and nothing else —
 * it is not reopened, and its resolution and intervals stay as they were
 * (design §2.5, N1). A second call for the same send does nothing.
 *
 * @param options.expired - The poller's send record had expired (#3713)
 */
export function settleLedgerAttempt(
  handle: LedgerAttemptHandle | null | undefined,
  result: AttemptResult,
  options: { expired?: boolean } = {},
): void {
  if (handle === null || handle === undefined) return;
  guarded(undefined, (state, now) => {
    const pending = state.pending.get(handle.attemptId);
    if (pending === undefined) return;
    state.pending.delete(handle.attemptId);
    const entry = state.entries.get(handle.confirmationId);
    emit<AttemptSettledLine>(state, AUTO_YES_LEDGER_EVENTS.attemptSettled, {
      atMs: now,
      confirmationId: handle.confirmationId,
      attemptId: handle.attemptId,
      cliToolId: pending.cliToolId,
      basis: pending.basis,
      result,
      late: entry === undefined,
      expired: options.expired === true,
      ...(pending.receiptAccepted ? { receiptAccepted: true } : {}),
    });
    if (entry === undefined) return;
    if (result === 'ok') {
      entry.attempts.ok += 1;
      entry.answered = true;
      endInterval(state, entry, 'answered', now);
      return;
    }
    if (result === 'partial') entry.attempts.partial += 1;
    else if (result === 'no-keys-sent') entry.attempts.noKeysSent += 1;
    else entry.attempts.failed += 1;
    if (entry.presence === 'present') withhold(state, entry, WITHHOLD_REASON_OF_RESULT[result], now);
  });
}

/**
 * The instance's poller stopped (design §4.2). A stop that ends the session or
 * hands the key over abandons its confirmations; any other (off, expired, the
 * stop pattern, errors, a shutdown) only stops looking — they turn
 * `unobservable`, their withheld interval ends, and the same confirmation is
 * continued if the next poller sees it again.
 */
export function noteLedgerPollerStopped(compositeKey: string, reason: string): void {
  guarded(undefined, (state, now) => {
    state.ticks.delete(compositeKey);
    for (const entry of [...state.entries.values()]) {
      if (entry.compositeKey !== compositeKey) continue;
      if (ABANDONING_STOP_REASONS.has(reason)) {
        closeEntry(state, entry, now, { kind: 'abandoned', reason });
        continue;
      }
      if (entry.presence === 'unobservable') continue;
      endInterval(state, entry, 'unobservable', now);
      entry.presence = 'unobservable';
      entry.unobservableSince = now;
      emit<PresenceChangedLine>(state, AUTO_YES_LEDGER_EVENTS.presenceChanged, {
        atMs: now,
        confirmationId: entry.id,
        from: 'present',
        to: 'unobservable',
        cause: reason,
      });
    }
  });
}

// =============================================================================
// Test seams
// =============================================================================

/**
 * One hour boundary's lines, stamped `atMs`, as the clock writes them.
 * @internal Exported for tests.
 */
export function runAutoYesLedgerHourForTests(atMs: number): void {
  guarded(undefined, (state) => runHour(state, atMs));
}

/** Drop the state (and its clock). @internal Exported for tests. */
export function resetAutoYesConfirmationLedgerForTests(): void {
  const state = globalThis.__autoYesConfirmationLedger;
  if (state?.clock?.timer) clockTimers.clearTimeout(state.clock.timer);
  globalThis.__autoYesConfirmationLedger = undefined;
  injectedFault = null;
}

/** Make every entry point fail as if it had thrown; null restores. @internal Exported for tests. */
export function setAutoYesLedgerFaultForTests(fault: Error | null): void {
  injectedFault = fault;
}

/** Replace the clock's timers; null restores the ones taken at load. @internal Exported for tests. */
export function setAutoYesLedgerClockTimersForTests(timers: ClockTimers | null): void {
  clockTimers = timers ?? loadedClockTimers;
}

/** The swallowed-exception count of this process (`ledgerErrors`). @internal Exported for tests. */
export function getAutoYesLedgerErrorCountForTests(): number {
  return globalThis.__autoYesConfirmationLedger?.errors ?? 0;
}
