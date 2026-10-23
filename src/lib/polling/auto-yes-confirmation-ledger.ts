/**
 * The Auto-Yes confirmation ledger (Issue #3820): one record per confirmation —
 * what Auto-Yes decided about it, each send and how it came back, how it went
 * away — and the intervals Auto-Yes left it alone, written as structured log
 * lines for agent-health's daily count (design
 * `docs/design/auto-yes-measurement-3820.md`; PR 1: the screen path, PR 2: the
 * hook route, the API adjudication and `/prompt-response`, PR 3: agy's call).
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
 * ## The hook, the API and `/prompt-response` (design §2.3, §2.4, PR 2)
 *
 * A hook request is its own record, opened by the hook route only (the API
 * adjudication never makes one) and closed when the reply is written; it holds
 * no waiting time. An `allow` on a source whose allow draws no dialog is also
 * the confirmation, opened and closed with the request. A screen confirmation
 * opened soon after a request on the same instance carries that fact
 * (`afterHookAllow` / `afterHookAbstain`), never the claim that it is the same
 * call. An opencode approval is a confirmation keyed by its decision id, open
 * until the reply settles it. A `/prompt-response` answer is a confirmation of
 * its own, opened and closed with the request.
 *
 * ## agy's call (design §2.4, PR 3)
 *
 * agy's `PreToolUse` names its call (`callId`, `<conversationId>:<stepIdx>`).
 * Its allow still draws the dialog, so the request opens no confirmation; the
 * screen's confirmation is tied to the call when the receipt that let it
 * through named one, and carries the request's id. It closes on whichever comes
 * first: gone from the screen, or the call's `PostToolUse`. A call that ends
 * with no confirmation ever tied to it gets a `dialogUnobserved` line on its
 * request — not observed, never "no dialog". A "No" sends no `PostToolUse`, so
 * that confirmation closes only by going from the screen.
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
import { buildCompositeKey } from '../auto-yes-state';
import { getOrInitGlobal } from '../global-state';
import { getEnterFallbackSessionEpoch } from './auto-yes-enter-fallback-state';
import {
  AUTO_YES_LEDGER_EVENTS,
  type AnswerBasis,
  type AttemptResult,
  type AttemptSettledLine,
  type CheckpointLine,
  type CliModeObservedLine,
  type ConfirmationClosedLine,
  type ConfirmationOpenedLine,
  type ConfirmationResolution,
  type ConfirmationResolvedBy,
  type ConfirmationSource,
  type HookRequestClosedLine,
  type HookRequestDialogUnobservedLine,
  type LedgerAliveLine,
  type LedgerStartedLine,
  type LedgerWithholdReason,
  type PresenceChangedLine,
  type WithholdEnd,
  type WithholdEndedLine,
  type WithholdReasonChangedLine,
  type WithholdStartedLine,
} from './auto-yes-confirmation-ledger-types';
import {
  ABANDONING_STOP_REASONS,
  AUTO_YES_LEDGER_CLOCK_MS,
  AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS,
  AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE,
  AUTO_YES_LEDGER_MAX_OPEN_TOTAL,
  AUTO_YES_LEDGER_RECORDED_PATHS,
  AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS,
  CLI_MODE_WORD,
  MAX_OPEN_HOOK_REQUESTS,
  MAX_PENDING_ATTEMPTS,
  MAX_REMEMBERED_CALLS,
  MAX_REMEMBERED_INSTANCES,
  SESSION_ENDING_STOP_REASONS,
  callKey,
  callsOf,
  currentEntry,
  currentLogLevel,
  emit,
  endedCallsOf,
  keyOf,
  rememberBounded,
  type ClockTimers,
  type LedgerAttemptHandle,
  type LedgerClock,
  type LedgerEntry,
  type LedgerHookDecision,
  type LedgerHookRequestScope,
  type LedgerScope,
  type LedgerState,
  type OpenInterval,
} from './auto-yes-ledger-records';

export {
  AUTO_YES_LEDGER_CLOCK_MS,
  AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS,
  AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE,
  AUTO_YES_LEDGER_MAX_OPEN_TOTAL,
  AUTO_YES_LEDGER_RECORDED_PATHS,
  AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS,
};
export type { LedgerAttemptHandle, LedgerHookDecision, LedgerHookRequestScope, LedgerScope };

declare global {
  // eslint-disable-next-line no-var
  var __autoYesConfirmationLedger: LedgerState | undefined;
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
      apiDecisions: new Map(),
      nextHookRequest: 0,
      hookRequests: new Map(),
      lastHookRequest: new Map(),
      cliModes: new Map(),
      current: new Map(),
      ticks: new Map(),
      nextTick: 0,
      pending: new Map(),
      calls: new Map(),
      endedCalls: new Map(),
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

type CloseHow =
  /** `resolvedBy` only where the cause is known (a human's `/prompt-response`, design §2.6). */
  | { kind: 'gone'; resolvedBy?: ConfirmationResolvedBy }
  | { kind: 'abandoned'; reason: string }
  /** The delivered reply itself released it (opencode's `settled`, design §2.6). */
  | { kind: 'reply' };

function closeEntry(state: LedgerState, entry: LedgerEntry, now: number, how: CloseHow): void {
  const wasUnobservable = entry.presence === 'unobservable';
  if (wasUnobservable && entry.unobservableSince !== null) {
    entry.unobservableMs += Math.max(0, now - entry.unobservableSince);
  }
  // Withheld only by the duplicate guard after an `ok`: the answer was landing.
  const waitingForAnswer = entry.answered && entry.interval?.reason === 'answered-recently';
  const withheldAtClose = entry.interval !== null && !waitingForAnswer;
  endInterval(state, entry, how.kind === 'abandoned' ? 'abandoned' : 'gone', now);
  let attemptsPending = 0;
  for (const pending of state.pending.values()) if (pending.confirmationId === entry.id) attemptsPending += 1;
  const sent = entry.nextAttempt > 0;
  let resolution: ConfirmationResolution;
  if (how.kind === 'abandoned') {
    resolution = sent ? 'unresolved-after-send' : 'abandoned';
  } else if (how.kind === 'reply') {
    resolution = 'resolved-by-reply';
  } else if (wasUnobservable) {
    resolution = 'gone-while-unobservable';
  } else if (withheldAtClose) {
    resolution = 'resolved-while-withheld';
  } else if (entry.answered) {
    resolution = 'resolved-after-answer';
  } else if (entry.intervals > 0) {
    // Answered never, withheld once and since answerable again.
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
    // The screen path cannot tell Auto-Yes's keys from a human's; only a
    // delivered reply that released it is known to be Auto-Yes's (design §2.6).
    resolvedBy: how.kind === 'reply' ? 'auto' : how.kind === 'gone' ? (how.resolvedBy ?? 'unknown') : 'unknown',
    openMs: Math.max(0, now - entry.openedAt),
    withheldMsTotal: entry.withheldMsClosed,
    unobservableMs: entry.unobservableMs,
    intervals: entry.intervals,
    ...(how.kind === 'abandoned' ? { abandonReason: how.reason } : {}),
  });
  state.entries.delete(entry.id);
  if (state.current.get(entry.compositeKey) === entry.id) state.current.delete(entry.compositeKey);
  if (entry.decisionKey !== undefined) state.apiDecisions.delete(entry.decisionKey);
}

/** Open a confirmation and write its `opened` line; the caller indexes it. */
function openEntry(
  state: LedgerState,
  scope: LedgerScope,
  compositeKey: string,
  fields: { source: ConfirmationSource; screenKey: string; promptType: string; decisionKey?: string },
  now: number,
  link: Pick<ConfirmationOpenedLine, 'afterHookAllow' | 'afterHookAbstain' | 'callId' | 'hookRequestId'> = {},
): LedgerEntry {
  makeRoom(state, compositeKey, now);
  state.nextConfirmation += 1;
  const opened: LedgerEntry = {
    id: `${state.bootId}-${state.nextConfirmation}`,
    compositeKey,
    worktreeId: scope.worktreeId,
    cliToolId: scope.cliToolId,
    instanceId: scope.instanceId ?? scope.cliToolId,
    source: fields.source,
    screenKey: fields.screenKey,
    ...(fields.decisionKey !== undefined ? { decisionKey: fields.decisionKey } : {}),
    ...(link.callId !== undefined ? { callId: link.callId } : {}),
    epoch: getEnterFallbackSessionEpoch(compositeKey),
    promptType: fields.promptType,
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
    autoYesStopped: false,
    observedTick: state.ticks.get(compositeKey) ?? 0,
  };
  state.entries.set(opened.id, opened);
  emit<ConfirmationOpenedLine>(state, AUTO_YES_LEDGER_EVENTS.opened, {
    atMs: now,
    confirmationId: opened.id,
    worktreeId: opened.worktreeId,
    cliToolId: opened.cliToolId,
    instanceId: opened.instanceId,
    source: opened.source,
    promptType: opened.promptType,
    ...link,
  });
  return opened;
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
    // A tick that read the screen and did not see the dialog of a call that
    // ended: it is off the screen now, and the next sighting is a new one.
    const ended = endedCallsOf(state).get(compositeKey);
    if (ended !== undefined && ended.seenTick !== tick) endedCallsOf(state).delete(compositeKey);
  });
}

/**
 * The tick sees a confirmation on screen. The same screen key in the same
 * session continues the open one (back to `present` if it was unobservable);
 * anything else closes it as gone and opens a new one.
 *
 * agy (PR 3, design §2.1・§2.4): `options.callId` is the call the receipt that
 * let the dialog through asked about. The hook's identity comes before the
 * screen's: a different call is another confirmation even under the same
 * screen key (the same command asked twice, no clear read between). A
 * confirmation with no call yet takes this one. The dialog of a call whose
 * `PostToolUse` already closed it is not reopened while it is still read.
 *
 * @param screenKey - `partialAnswerScreenKey` of the prompt (kept in memory, never logged)
 */
export function observeLedgerScreen(
  scope: LedgerScope,
  screenKey: string,
  promptType: string,
  options: { callId?: string } = {},
): void {
  guarded(undefined, (state, now) => {
    const compositeKey = keyOf(scope);
    const epoch = getEnterFallbackSessionEpoch(compositeKey);
    const tick = state.ticks.get(compositeKey) ?? 0;
    const callId = options.callId;
    let entry = currentEntry(state, compositeKey);
    const otherCall = entry !== undefined && callId !== undefined && entry.callId !== undefined && entry.callId !== callId;
    if (entry !== undefined && (entry.screenKey !== screenKey || entry.epoch !== epoch || otherCall)) {
      closeEntry(
        state,
        entry,
        now,
        entry.epoch !== epoch ? { kind: 'abandoned', reason: 'session-epoch-changed' } : { kind: 'gone' },
      );
      entry = undefined;
    }
    if (entry === undefined) {
      const ended = endedCallsOf(state).get(compositeKey);
      if (
        ended !== undefined &&
        ended.epoch === epoch &&
        ended.screenKey === screenKey &&
        (callId === undefined || callId === ended.callId)
      ) {
        ended.seenTick = tick;
        return;
      }
      endedCallsOf(state).delete(compositeKey);
      const opened = openEntry(
        state,
        scope,
        compositeKey,
        { source: 'screen', screenKey, promptType },
        now,
        { ...hookLink(state, compositeKey, now), ...callLink(state, compositeKey, callId) },
      );
      state.current.set(compositeKey, opened.id);
      return;
    }
    if (callId !== undefined && entry.callId === undefined) {
      // Seen before the receipt was judged for it; tied now, so its call's
      // `PostToolUse` closes it and the request is not "unobserved".
      entry.callId = callId;
      callLink(state, compositeKey, callId);
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
 * Tie a screen confirmation to agy's call: marks the call observed and gives
 * the `opened` line its `callId` and the request's id (PR 3).
 */
function callLink(
  state: LedgerState,
  compositeKey: string,
  callId: string | undefined,
): Pick<ConfirmationOpenedLine, 'callId' | 'hookRequestId'> {
  if (callId === undefined) return {};
  const call = callsOf(state).get(callKey(compositeKey, callId));
  if (call === undefined) return { callId };
  call.observed = true;
  return { callId, hookRequestId: call.hookRequestId };
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
    return beginAttempt(state, entry, basis, options.receiptAccepted === true);
  });
}

function beginAttempt(state: LedgerState, entry: LedgerEntry, basis: AnswerBasis, receiptAccepted: boolean): LedgerAttemptHandle {
  entry.nextAttempt += 1;
  entry.decision = 'answer';
  entry.basis = basis;
  const handle: LedgerAttemptHandle = { confirmationId: entry.id, attemptId: `${entry.id}.${entry.nextAttempt}` };
  if (state.pending.size >= MAX_PENDING_ATTEMPTS) {
    const oldest = state.pending.keys().next().value;
    if (oldest !== undefined) state.pending.delete(oldest);
  }
  state.pending.set(handle.attemptId, { confirmationId: entry.id, cliToolId: entry.cliToolId, basis, receiptAccepted });
  return handle;
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
  guarded(undefined, (state, now) => settleAttempt(state, handle, result, options.expired === true, now));
}

function settleAttempt(
  state: LedgerState,
  handle: LedgerAttemptHandle,
  result: AttemptResult,
  expired: boolean,
  now: number,
  options: { withholdOnFailure?: boolean } = {},
): void {
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
    expired,
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
  if (entry.presence === 'present' && !entry.autoYesStopped && options.withholdOnFailure !== false) {
    withhold(state, entry, WITHHOLD_REASON_OF_RESULT[result], now);
  }
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
    // The session is over: no frame of it is read again, the next sighting is new.
    if (SESSION_ENDING_STOP_REASONS.has(reason)) endedCallsOf(state).delete(compositeKey);
    for (const entry of [...state.entries.values()]) {
      if (entry.compositeKey === compositeKey) noteEntryStopped(state, entry, reason, now);
    }
  });
}

/**
 * Every poller of a worktree stopped, or the worktree went: the same as
 * {@link noteLedgerPollerStopped} for each confirmation the worktree holds,
 * whether or not a poller was running for its instance (design §4.2). An API
 * approval is opened with Auto-Yes off too, so the keys of the running pollers
 * do not name every instance with an open confirmation.
 */
export function noteLedgerWorktreeStopped(worktreeId: string, reason: string): void {
  guarded(undefined, (state, now) => {
    if (SESSION_ENDING_STOP_REASONS.has(reason)) {
      const endedCalls = endedCallsOf(state);
      for (const [compositeKey, ended] of [...endedCalls]) {
        if (ended.worktreeId === worktreeId) endedCalls.delete(compositeKey);
      }
    }
    for (const entry of [...state.entries.values()]) {
      if (entry.worktreeId !== worktreeId) continue;
      state.ticks.delete(entry.compositeKey);
      noteEntryStopped(state, entry, reason, now);
    }
  });
}

function noteEntryStopped(state: LedgerState, entry: LedgerEntry, reason: string, now: number): void {
  if (ABANDONING_STOP_REASONS.has(reason)) {
    closeEntry(state, entry, now, { kind: 'abandoned', reason });
    return;
  }
  if (entry.source !== 'screen') {
    // An API approval is not read off the screen: the poller stopping does not
    // stop it being seen (its reply still settles it), so it stays open and
    // `present`. Auto-Yes stopped answering it, though, so a withheld interval
    // ends here: the time it is off is nobody's withheld time.
    endInterval(state, entry, 'stopped', now);
    entry.autoYesStopped = true;
    return;
  }
  if (entry.presence === 'unobservable') return;
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

/** `afterHookAllow` / `afterHookAbstain` for a screen confirmation opened `now` (design §2.3). */
function hookLink(
  state: LedgerState,
  compositeKey: string,
  now: number,
): Pick<ConfirmationOpenedLine, 'afterHookAllow' | 'afterHookAbstain'> {
  const recent = state.lastHookRequest.get(compositeKey);
  if (recent === undefined || now - recent.at > AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS) return {};
  return recent.outcome === 'allow' ? { afterHookAllow: true } : { afterHookAbstain: recent.abstainReason ?? 'unknown' };
}

// =============================================================================
// The hook path (the hook route and the adjudication it calls, PR 2)
// =============================================================================

/**
 * A hook request arrived. **Only the hook route calls this** (design §2.3,
 * N2): the API adjudication shares the adjudicator but makes no hook request.
 *
 * @returns The request's id, for {@link decideLedgerHookRequest} and
 *   {@link closeLedgerHookRequest}; null when the ledger failed
 */
export function beginLedgerHookRequest(scope: LedgerHookRequestScope, receivedAtMs: number): string | null {
  return guarded<string | null>(null, (state) => {
    state.nextHookRequest += 1;
    const id = `${state.bootId}-h${state.nextHookRequest}`;
    const instanceId = scope.instanceId ?? scope.cliToolId;
    rememberBounded(
      state.hookRequests,
      id,
      {
        id,
        compositeKey: scope.worktreeId === null ? null : buildCompositeKey(scope.worktreeId, scope.cliToolId, instanceId),
        worktreeId: scope.worktreeId,
        cliToolId: scope.cliToolId,
        instanceId,
        receivedAt: receivedAtMs,
        decision: null,
        confirmation: null,
      },
      MAX_OPEN_HOOK_REQUESTS,
    );
    return id;
  });
}

/**
 * The adjudicator decided about a hook request. An `allow` on a source whose
 * allow draws no dialog makes the request the confirmation (design §2.3): it
 * is opened here and closed with the request. Any other outcome opens nothing —
 * a dialog that follows is the screen's confirmation, which alone holds the
 * waiting time (the rule against counting it twice).
 */
export function decideLedgerHookRequest(hookRequestId: string | null | undefined, decision: LedgerHookDecision): void {
  if (hookRequestId === null || hookRequestId === undefined) return;
  guarded(undefined, (state, now) => {
    const request = state.hookRequests.get(hookRequestId);
    if (request === undefined) return;
    request.decision = { ...decision };
    if (decision.outcome !== 'allow' || !decision.allowSuppressesDialog || request.worktreeId === null) return;
    if (request.confirmation !== null) return;
    state.nextConfirmation += 1;
    const confirmation = { id: `${state.bootId}-${state.nextConfirmation}`, openedAt: now, promptType: decision.promptType };
    request.confirmation = confirmation;
    emit<ConfirmationOpenedLine>(state, AUTO_YES_LEDGER_EVENTS.opened, {
      atMs: now,
      confirmationId: confirmation.id,
      worktreeId: request.worktreeId,
      cliToolId: request.cliToolId,
      instanceId: request.instanceId,
      source: 'hook',
      promptType: confirmation.promptType,
      hookRequestId,
    });
  });
}

/**
 * The hook route wrote its reply. `delivered: false` is a verdict that did not
 * leave — the route's catch-all, or a delivery whose receipt said so: whatever
 * had been decided, the agent got an abstention, so the request is closed
 * `abstained` (`failure`, `error` when omitted) and a confirmation it was is
 * closed unanswered, its send `failed`.
 */
export function closeLedgerHookRequest(
  hookRequestId: string | null | undefined,
  reply: { delivered: boolean; failure?: string },
): void {
  if (hookRequestId === null || hookRequestId === undefined) return;
  guarded(undefined, (state, now) => {
    const request = state.hookRequests.get(hookRequestId);
    if (request === undefined) return;
    state.hookRequests.delete(hookRequestId);
    const decision = request.decision;
    const outcome = reply.delivered && decision !== null ? decision.outcome : 'abstained';
    const failure = reply.failure ?? 'error';
    const abstainReason = !reply.delivered ? failure : decision === null ? 'undecided' : decision.abstainReason;
    const confirmation = request.confirmation;
    if (confirmation !== null && request.worktreeId !== null) {
      const ok = reply.delivered;
      emit<AttemptSettledLine>(state, AUTO_YES_LEDGER_EVENTS.attemptSettled, {
        atMs: now,
        confirmationId: confirmation.id,
        attemptId: `${confirmation.id}.1`,
        cliToolId: request.cliToolId,
        basis: 'L1',
        result: ok ? 'ok' : 'failed',
        late: false,
        expired: false,
      });
      emit<ConfirmationClosedLine>(state, AUTO_YES_LEDGER_EVENTS.closed, {
        atMs: now,
        confirmationId: confirmation.id,
        worktreeId: request.worktreeId,
        cliToolId: request.cliToolId,
        instanceId: request.instanceId,
        source: 'hook',
        promptType: confirmation.promptType,
        decision: 'answer',
        basis: 'L1',
        attempts: { ok: ok ? 1 : 0, partial: 0, noKeysSent: 0, failed: ok ? 0 : 1 },
        attemptsPending: 0,
        answeredAtClose: ok,
        resolution: ok ? 'resolved-by-reply' : 'unresolved-after-send',
        resolvedBy: ok ? 'auto' : 'unknown',
        openMs: Math.max(0, now - confirmation.openedAt),
        withheldMsTotal: 0,
        unobservableMs: 0,
        intervals: 0,
        ...(ok ? {} : { abandonReason: failure }),
      });
    }
    emit<HookRequestClosedLine>(state, AUTO_YES_LEDGER_EVENTS.hookRequestClosed, {
      atMs: now,
      hookRequestId,
      cliToolId: request.cliToolId,
      outcome,
      ...(outcome === 'abstained' && abstainReason !== undefined ? { abstainReason } : {}),
      allowSuppressesDialog: decision?.allowSuppressesDialog ?? false,
      replyMs: Math.max(0, now - request.receivedAt),
      ...(decision?.callId !== undefined ? { callId: decision.callId } : {}),
    });
    // PR 3: a call the request opened no confirmation for waits for the
    // screen's confirmation to be tied to it, or for its `PostToolUse`.
    if (request.compositeKey !== null && decision?.callId !== undefined && confirmation === null) {
      rememberBounded(
        callsOf(state),
        callKey(request.compositeKey, decision.callId),
        { hookRequestId, cliToolId: request.cliToolId, observed: false },
        MAX_REMEMBERED_CALLS,
      );
    }
    if (request.compositeKey !== null) {
      rememberBounded(
        state.lastHookRequest,
        request.compositeKey,
        { at: now, outcome, ...(outcome === 'abstained' && abstainReason !== undefined ? { abstainReason } : {}) },
        MAX_REMEMBERED_INSTANCES,
      );
    }
  });
}

/**
 * agy's call `callId` ended: its `PostToolUse` came (design §2.4, §2.6, PR 3).
 * The screen confirmation tied to it closes as gone, if it had not gone from
 * the screen first (who answered is not known: `unknown`). A call no
 * confirmation was ever tied to writes `dialogUnobserved` on its hook request
 * — and opens nothing. A call this ledger never heard asked about (a restart
 * in between, a body without `stepIdx`) writes nothing; so does a second
 * `PostToolUse` for the same call.
 */
export function noteLedgerToolCallEnded(scope: LedgerScope, callId: string | null | undefined): void {
  if (callId === null || callId === undefined) return;
  guarded(undefined, (state, now) => {
    const compositeKey = keyOf(scope);
    for (const entry of [...state.entries.values()]) {
      if (entry.compositeKey !== compositeKey || entry.callId !== callId) continue;
      const wasCurrent = state.current.get(compositeKey) === entry.id;
      closeEntry(state, entry, now, { kind: 'gone' });
      if (wasCurrent) {
        rememberBounded(
          endedCallsOf(state),
          compositeKey,
          {
            callId,
            screenKey: entry.screenKey,
            worktreeId: entry.worktreeId,
            epoch: entry.epoch,
            seenTick: state.ticks.get(compositeKey) ?? 0,
          },
          MAX_REMEMBERED_INSTANCES,
        );
      }
    }
    const key = callKey(compositeKey, callId);
    const call = callsOf(state).get(key);
    if (call === undefined) return;
    callsOf(state).delete(key);
    if (call.observed) return;
    emit<HookRequestDialogUnobservedLine>(state, AUTO_YES_LEDGER_EVENTS.hookRequestDialogUnobserved, {
      atMs: now,
      hookRequestId: call.hookRequestId,
      cliToolId: call.cliToolId,
      callId,
      dialogUnobserved: true,
    });
  });
}

/**
 * The CLI's own permission mode, as a `PermissionRequest` stated it (design
 * §3.4). A line the first time an instance's session shows one and whenever it
 * changes; a new session forgets it. Instances that never show one write
 * nothing — the count reads them as unknown, never as zero.
 */
export function observeLedgerCliMode(scope: LedgerScope, mode: string): void {
  guarded(undefined, (state, now) => {
    const compositeKey = keyOf(scope);
    const epoch = getEnterFallbackSessionEpoch(compositeKey);
    const word = CLI_MODE_WORD.test(mode) ? mode : '(other)';
    const seen = state.cliModes.get(compositeKey);
    const sameSession = seen !== undefined && seen.epoch === epoch;
    if (sameSession && seen.mode === word) return;
    rememberBounded(state.cliModes, compositeKey, { epoch, mode: word }, MAX_REMEMBERED_INSTANCES);
    emit<CliModeObservedLine>(state, AUTO_YES_LEDGER_EVENTS.cliModeObserved, {
      atMs: now,
      worktreeId: scope.worktreeId,
      cliToolId: scope.cliToolId,
      instanceId: scope.instanceId ?? scope.cliToolId,
      sessionEpoch: epoch,
      mode: word,
      change: sameSession ? 'changed' : 'first',
    });
  });
}

// =============================================================================
// The API path (an approval CommandMate holds: opencode, PR 2)
// =============================================================================

/** What one adjudication of a held approval did (`adjudicatePendingPermission`). */
export interface LedgerApiAdjudication {
  outcome: 'allow' | 'abstained';
  /** Why Auto-Yes withheld it, when a policy did; an abstention without one (Auto-Yes off) withholds nothing. */
  withholdReason?: LedgerWithholdReason;
  /** The verdict reached the agent. Meaningful for an `allow`. */
  delivered: boolean;
  /** The delivery released the approval (the source declares that a reply does). */
  settled: boolean;
  promptType: string;
}

/** What was decided about a held approval, before its verdict is delivered. */
export type LedgerApiVerdict = Pick<LedgerApiAdjudication, 'outcome' | 'withholdReason' | 'promptType'>;

/** How the delivery of an `allow` came back. */
export type LedgerApiDelivery = Pick<LedgerApiAdjudication, 'delivered' | 'settled'>;

/**
 * One adjudication of the approval `decisionId` (design §2.4), in one call.
 * The same as {@link beginLedgerApiAdjudication} followed at once by
 * {@link settleLedgerApiAdjudication}; a caller that awaits the delivery in
 * between uses the two.
 */
export function recordLedgerApiAdjudication(
  scope: LedgerScope,
  decisionId: string,
  adjudication: LedgerApiAdjudication,
): void {
  settleLedgerApiAdjudication(beginLedgerApiAdjudication(scope, decisionId, adjudication), adjudication);
}

/**
 * An adjudication of the approval `decisionId` decided, and its verdict is
 * about to be delivered (design §2.4). Called before the delivery's first
 * await, as the screen path takes its handle (§2.5): the first adjudication
 * opens the confirmation, a re-adjudication (re-connect, Auto-Yes switched on)
 * continues it, a policy's abstention withholds it. An `allow` is a send,
 * begun here.
 *
 * @returns The send's handle, for {@link settleLedgerApiAdjudication}; null for
 *   an abstention (or when the ledger failed)
 */
export function beginLedgerApiAdjudication(
  scope: LedgerScope,
  decisionId: string,
  verdict: LedgerApiVerdict,
): LedgerAttemptHandle | null {
  return guarded<LedgerAttemptHandle | null>(null, (state, now) => {
    const compositeKey = keyOf(scope);
    const decisionKey = `${compositeKey}\u0000${decisionId}`;
    const knownId = state.apiDecisions.get(decisionKey);
    let entry = knownId === undefined ? undefined : state.entries.get(knownId);
    if (entry === undefined) {
      entry = openEntry(state, scope, compositeKey, {
        source: 'api',
        screenKey: '',
        promptType: verdict.promptType,
        decisionKey,
      }, now);
      state.apiDecisions.set(decisionKey, entry.id);
    }
    // Adjudicated again with Auto-Yes on (an allow, or a policy's withholding):
    // its intervals are this period's.
    if (verdict.outcome === 'allow' || verdict.withholdReason !== undefined) entry.autoYesStopped = false;
    if (verdict.outcome === 'allow') return beginAttempt(state, entry, 'L1', false);
    if (verdict.withholdReason !== undefined) {
      entry.decision = 'withhold';
      withhold(state, entry, verdict.withholdReason, now);
    }
    return null;
  });
}

/**
 * The delivery of an `allow` came back: `delivered` is the send's result, and
 * a settled reply closes the confirmation, answered by Auto-Yes. The result
 * belongs to the confirmation the send was begun for — one that closed
 * meanwhile (a session killed during the delivery) gets a `late` line and is
 * neither reopened nor closed again (design §2.5, N1).
 */
export function settleLedgerApiAdjudication(
  handle: LedgerAttemptHandle | null | undefined,
  delivery: LedgerApiDelivery,
): void {
  if (handle === null || handle === undefined) return;
  guarded(undefined, (state, now) => {
    settleAttempt(state, handle, delivery.delivered ? 'ok' : 'failed', false, now);
    const entry = state.entries.get(handle.confirmationId);
    if (entry !== undefined && delivery.delivered && delivery.settled) closeEntry(state, entry, now, { kind: 'reply' });
  });
}

/**
 * The agent said the approval `decisionId` was answered (opencode's
 * `permission.replied`) — by this server, another client or a human at the
 * terminal. An open confirmation closes as gone; who answered is not known.
 */
export function noteLedgerApiDecisionReplied(scope: LedgerScope, decisionId: string): void {
  guarded(undefined, (state, now) => {
    const knownId = state.apiDecisions.get(`${keyOf(scope)}\u0000${decisionId}`);
    const entry = knownId === undefined ? undefined : state.entries.get(knownId);
    if (entry !== undefined) closeEntry(state, entry, now, { kind: 'gone' });
  });
}

// =============================================================================
// The `/prompt-response` path (PR 2)
// =============================================================================

/** One `/prompt-response` request that reached the session (design §2.1, §2.5). */
export interface LedgerPromptResponse {
  /** `browser` when the body said it came from the browser's Auto-Yes, `human` otherwise. */
  basis: Extract<AnswerBasis, 'browser' | 'human'>;
  promptType: string;
  /** `ok` for a 200 `success: true`; anything else (`success: false`, a 500) is `failed`. */
  result: Extract<AttemptResult, 'ok' | 'failed'>;
}

/**
 * A `/prompt-response` answer: a confirmation of its own, opened and closed
 * with the request, with its one send. A failure is never an answer. Only a
 * human's successful answer names who resolved it (`human-ui`, design §2.6).
 */
export function recordLedgerPromptResponse(scope: LedgerScope, response: LedgerPromptResponse): void {
  guarded(undefined, (state, now) => {
    const entry = openEntry(state, scope, keyOf(scope), {
      source: 'prompt-response',
      screenKey: '',
      promptType: response.promptType,
    }, now);
    const handle = beginAttempt(state, entry, response.basis, false);
    if (response.basis === 'human') entry.decision = 'none';
    // Closed in the same call, so a failure opens no withheld interval.
    settleAttempt(state, handle, response.result, false, now, { withholdOnFailure: false });
    if (response.result === 'ok') {
      closeEntry(state, entry, now, { kind: 'gone', resolvedBy: response.basis === 'human' ? 'human-ui' : 'unknown' });
      return;
    }
    closeEntry(state, entry, now, { kind: 'abandoned', reason: 'send-failed' });
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
