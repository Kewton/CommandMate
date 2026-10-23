/**
 * The Auto-Yes confirmation ledger's records (Issue #3848, split out of
 * `auto-yes-confirmation-ledger.ts`): its constants, the shapes of its state,
 * the writing of one line, and the small helpers over the state. The state
 * itself — `ledgerState()`, the clock, the test seams — stays owned by
 * `auto-yes-confirmation-ledger.ts`, which re-exports the public names here.
 *
 * Server only (logger). Must not import `auto-yes-confirmation-ledger.ts`.
 *
 * @module lib/polling/auto-yes-ledger-records
 */

import type { CLIToolType } from '../cli-tools/types';
import { createLogger, type Logger } from '@/lib/logger';
import { getLogConfig } from '@/lib/env';
import { buildCompositeKey } from '../auto-yes-state';
import {
  AUTO_YES_LEDGER_LOG_MODULE,
  AUTO_YES_LEDGER_VERSION,
  type AnswerBasis,
  type AttemptCounts,
  type AutoYesLedgerPath,
  type ConfirmationDecision,
  type ConfirmationSource,
  type LedgerLineBase,
  type LedgerWithholdReason,
} from './auto-yes-confirmation-ledger-types';

/**
 * The paths this version records (design §6.4): PR 1 the poller's screen path,
 * PR 2 the hook route, the API adjudication and `/prompt-response`, PR 3 the
 * link of agy's request to its dialog (`agy-link`). With all five the daily
 * count is no longer partial for want of a path.
 */
export const AUTO_YES_LEDGER_RECORDED_PATHS: readonly AutoYesLedgerPath[] = [
  'screen',
  'hook',
  'api',
  'prompt-response',
  'agy-link',
];

/**
 * A screen confirmation opened this soon after a hook request closed on the
 * same instance carries `afterHookAllow` / `afterHookAbstain` (design §2.3).
 * agy's receipt window is the same length.
 */
export const AUTO_YES_LEDGER_HOOK_LINK_WINDOW_MS = 8_000;

/** The grid of the `alive` and `checkpoint` lines: every UTC hour boundary. */
export const AUTO_YES_LEDGER_CLOCK_MS = 60 * 60 * 1000;

/** An `unobservable` confirmation is let go after this long (design §4.2). */
export const AUTO_YES_LEDGER_UNOBSERVABLE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Open confirmations one instance may hold; the oldest goes past it (design §8.2). */
export const AUTO_YES_LEDGER_MAX_OPEN_PER_INSTANCE = 16;

/** Open confirmations the process may hold; the oldest goes past it (design §8.2). */
export const AUTO_YES_LEDGER_MAX_OPEN_TOTAL = 1024;

/** Sends whose result has not come back that are remembered; the oldest is dropped past it. */
export const MAX_PENDING_ATTEMPTS = 1024;

/** Hook requests whose reply has not been written that are remembered; the oldest is dropped past it. */
export const MAX_OPEN_HOOK_REQUESTS = 1024;

/** Instances whose last hook request or CLI mode is remembered; the oldest is dropped past it. */
export const MAX_REMEMBERED_INSTANCES = 1024;

/** agy calls whose `PostToolUse` has not come that are remembered; the oldest is dropped past it. */
export const MAX_REMEMBERED_CALLS = 1024;

/** A CLI mode is a word of the CLI's own vocabulary; anything else is logged as `(other)`. */
export const CLI_MODE_WORD = /^[A-Za-z][A-Za-z-]{0,31}$/;

/**
 * Poller stop reasons that end the session the confirmation was on, or hand
 * the key to something else (design §4.2). Every other reason — off, expired,
 * the stop pattern, errors, a shutdown — only stops looking.
 */
export const ABANDONING_STOP_REASONS: ReadonlySet<string> = new Set([
  'invalid-key',
  'session-killed',
  'instance-removed',
  'worktree-deleted',
  'orphan-swept',
  'worktree-id-migrated',
  'replaced',
  'reset',
]);

/**
 * The stop reasons among {@link ABANDONING_STOP_REASONS} that end the agent's
 * session itself: the memory of a call its `PostToolUse` closed (PR 3) goes
 * with them. Any other reason — Auto-Yes turned off by hand, expired, the stop
 * pattern, a key handed over, one this list does not know — keeps it, so a
 * stale frame of that call is not counted again when Auto-Yes comes back on;
 * the session epoch still tells a relaunched session apart.
 */
export const SESSION_ENDING_STOP_REASONS: ReadonlySet<string> = new Set([
  'session-killed',
  'instance-removed',
  'worktree-deleted',
  'orphan-swept',
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

export interface OpenInterval {
  id: string;
  startedAt: number;
  reason: LedgerWithholdReason;
}

export interface LedgerEntry {
  id: string;
  compositeKey: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  source: ConfirmationSource;
  /** What tells this confirmation from the next on the same screen (`partialAnswerScreenKey`). Memory only. */
  screenKey: string;
  /** API confirmations: their key in `apiDecisions`. */
  decisionKey?: string;
  /** agy: the call it is tied to (PR 3). Set once; a different call is another confirmation. */
  callId?: string;
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
  /**
   * API confirmations: Auto-Yes stopped (a poller stop that did not end the
   * session) and has not adjudicated it since. A send that comes back failed
   * meanwhile opens no withheld interval — the time Auto-Yes is off is nobody's
   * withheld time; the next adjudication, Auto-Yes back on, decides afresh.
   */
  autoYesStopped: boolean;
  /** The ledger tick that last saw it on screen. */
  observedTick: number;
}

export interface PendingAttempt {
  confirmationId: string;
  cliToolId: CLIToolType;
  basis: AnswerBasis;
  receiptAccepted: boolean;
}

/** Which instance a hook request came from; the worktree is null when it named none this server knows. */
export interface LedgerHookRequestScope {
  worktreeId: string | null;
  cliToolId: CLIToolType;
  instanceId: string | undefined;
}

/** What the adjudication decided about a hook request (design §2.3). */
export interface LedgerHookDecision {
  outcome: 'allow' | 'abstained';
  /** The adjudicator's reason, when it abstained. */
  abstainReason?: string;
  /** The source's `permissionAllowSuppressesDialog`. */
  allowSuppressesDialog: boolean;
  promptType: string;
  /** agy's call the request asked about (PR 3). */
  callId?: string;
}

export interface OpenHookRequest {
  id: string;
  compositeKey: string | null;
  worktreeId: string | null;
  cliToolId: CLIToolType;
  instanceId: string;
  receivedAt: number;
  decision: LedgerHookDecision | null;
  /** The confirmation the request is, when it was allowed on a source whose allow draws no dialog. */
  confirmation: { id: string; openedAt: number; promptType: string } | null;
}

export interface RecentHookRequest {
  at: number;
  outcome: 'allow' | 'abstained';
  abstainReason?: string;
}

/** An agy call a closed hook request asked about, until its `PostToolUse` (PR 3). */
export interface LedgerCall {
  hookRequestId: string;
  cliToolId: CLIToolType;
  /** A confirmation on screen was tied to it. */
  observed: boolean;
}

/**
 * The confirmation a `PostToolUse` closed, while its dialog may still be read
 * off a stale frame — of the session it was closed in only: a relaunched
 * session's first sighting is a new confirmation.
 */
export interface EndedCall {
  callId: string;
  screenKey: string;
  worktreeId: string;
  /** The session epoch it was closed in (`getEnterFallbackSessionEpoch`). */
  epoch: number;
  /** The ledger tick that last read it. */
  seenTick: number;
}

export interface LedgerClock {
  timer: ReturnType<typeof setTimeout> | null;
  dueAt: number;
}

export interface LedgerState {
  bootId: string;
  startedAt: number;
  nextConfirmation: number;
  /** Insertion order is age: the first is the oldest (capacity). */
  entries: Map<string, LedgerEntry>;
  /** `<compositeKey>\u0000<decisionId>` -> the API confirmation of that decision. */
  apiDecisions: Map<string, string>;
  nextHookRequest: number;
  hookRequests: Map<string, OpenHookRequest>;
  /** compositeKey -> the last hook request closed on that instance. */
  lastHookRequest: Map<string, RecentHookRequest>;
  /** compositeKey -> the CLI mode last seen on that instance, in its session. */
  cliModes: Map<string, { epoch: number; mode: string }>;
  /** compositeKey -> the screen confirmation of that instance. */
  current: Map<string, string>;
  /** compositeKey -> the ledger tick in progress. */
  ticks: Map<string, number>;
  nextTick: number;
  pending: Map<string, PendingAttempt>;
  /**
   * `<compositeKey>\u0000<callId>` -> the agy call (PR 3). Optional, like
   * `endedCalls`: a state made by an older bundle (hot reload) has neither.
   */
  calls?: Map<string, LedgerCall>;
  /** compositeKey -> the confirmation the call's `PostToolUse` closed (PR 3), at most {@link MAX_REMEMBERED_INSTANCES}. */
  endedCalls?: Map<string, EndedCall>;
  errors: number;
  lastAliveAt: number | null;
  clock: LedgerClock | null;
}

export interface ClockTimers {
  setTimeout: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimeout: (timer: ReturnType<typeof setTimeout>) => void;
}

let cachedLogger: Logger | null = null;
export function ledgerLogger(): Logger {
  cachedLogger ??= createLogger(AUTO_YES_LEDGER_LOG_MODULE);
  return cachedLogger;
}

export function currentLogLevel(): string {
  try {
    return getLogConfig().level;
  } catch {
    return 'unknown';
  }
}

export type LineFields<T extends LedgerLineBase> = Omit<T, 'ledgerVersion' | 'bootId'>;

/** Write one line. A logger that throws is counted, never passed on. */
export function emit<T extends LedgerLineBase>(state: LedgerState, event: string, fields: LineFields<T>): void {
  try {
    ledgerLogger().info(event, { ledgerVersion: AUTO_YES_LEDGER_VERSION, bootId: state.bootId, ...fields });
  } catch {
    state.errors += 1;
  }
}

export function callsOf(state: LedgerState): Map<string, LedgerCall> {
  state.calls ??= new Map();
  return state.calls;
}

export function endedCallsOf(state: LedgerState): Map<string, EndedCall> {
  state.endedCalls ??= new Map();
  return state.endedCalls;
}

export function callKey(compositeKey: string, callId: string): string {
  return `${compositeKey}\u0000${callId}`;
}

export function keyOf(scope: LedgerScope): string {
  return scope.compositeKey ?? buildCompositeKey(scope.worktreeId, scope.cliToolId, scope.instanceId);
}

export function currentEntry(state: LedgerState, compositeKey: string): LedgerEntry | undefined {
  const id = state.current.get(compositeKey);
  return id === undefined ? undefined : state.entries.get(id);
}

/** Set `key` in a map kept to `max` entries, dropping the oldest. */
export function rememberBounded<V>(map: Map<string, V>, key: string, value: V, max: number): void {
  map.delete(key);
  if (map.size >= max) {
    const oldest = map.keys().next().value;
    if (oldest !== undefined) map.delete(oldest);
  }
  map.set(key, value);
}

