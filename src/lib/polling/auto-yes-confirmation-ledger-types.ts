/**
 * The vocabulary of the Auto-Yes confirmation ledger's log lines, for every
 * path (Issue #3820, design `docs/design/auto-yes-measurement-3820.md` §3.3).
 *
 * Fixed here, in PR 1, for all of them: the poller (screen) writes its lines
 * now; the hook route, the API adjudication and `/prompt-response` (PR 2) and
 * the agy link (PR 3) write theirs through the same ledger later, and the daily
 * aggregation (PR 4) reads all of them. A line is fixed-size on purpose: codes
 * and ids only — never a question, a command or a path — and no arrays except
 * `segments`, whose length is bounded by the number of paths.
 *
 * Types and constants only, so a reader (the aggregation, tests) can import it
 * without the ledger's state or its logger.
 *
 * @module lib/polling/auto-yes-confirmation-ledger-types
 */

import type { CLIToolType } from '../cli-tools/types';
import type { AutoYesSuppressionReason } from './auto-yes-suppression-reason';

/** The version of this vocabulary, on every line (`ledgerVersion`). */
export const AUTO_YES_LEDGER_VERSION = 1;

/** The log module every ledger line is written under (`[time] [INFO] [<module>] <event> {json}`). */
export const AUTO_YES_LEDGER_LOG_MODULE = 'auto-yes-confirmation-ledger';

/** The ledger's log line names (design §3.3). */
export const AUTO_YES_LEDGER_EVENTS = {
  started: 'auto-yes-ledger-started',
  alive: 'auto-yes-ledger-alive',
  opened: 'auto-yes-confirmation-opened',
  withholdStarted: 'auto-yes-withhold-started',
  withholdReasonChanged: 'auto-yes-withhold-reason-changed',
  withholdEnded: 'auto-yes-withhold-ended',
  attemptSettled: 'auto-yes-confirmation-attempt-settled',
  presenceChanged: 'auto-yes-confirmation-presence-changed',
  checkpoint: 'auto-yes-confirmation-checkpoint',
  closed: 'auto-yes-confirmation-closed',
  /** PR 2: written by the hook route only — the API adjudication never makes a hook request. */
  hookRequestClosed: 'auto-yes-hook-request-closed',
  /** PR 3. */
  hookRequestDialogUnobserved: 'auto-yes-hook-request-dialog-unobserved',
  /** PR 2. */
  cliModeObserved: 'auto-yes-cli-mode-observed',
} as const;

export type AutoYesLedgerEvent = (typeof AUTO_YES_LEDGER_EVENTS)[keyof typeof AUTO_YES_LEDGER_EVENTS];

/** What a ledger version records; on `started` and in the `segments` of `alive` (design §6.4). */
export type AutoYesLedgerPath = 'screen' | 'hook' | 'api' | 'prompt-response' | 'agy-link';

/** Where a confirmation was seen or received. */
export type ConfirmationSource = 'screen' | 'hook' | 'api' | 'prompt-response';

/**
 * The level of evidence an answer was given on (design §0). `human` is not
 * Auto-Yes's: a person's answer through `/prompt-response` (PR 2), recorded
 * so the browser's Auto-Yes (`browser`) can be told from it.
 */
export type AnswerBasis = 'L1' | 'L2' | 'L3' | 'L4' | 'enter-fallback' | 'browser' | 'human';

/**
 * Reasons only the ledger records (design §2.2, §2.5): a stop that is not a
 * policy suppression, so `lastPolicySuppression` never carries it.
 */
export type LedgerOnlyWithholdReason =
  /** A send threw and whether keys reached the pane is not known. */
  | 'send-failed'
  /** A send stopped before any key reached the pane. */
  | 'send-no-keys'
  /** The session is another server's (#2865). */
  | 'foreign-session'
  /** A send a worktree ID move carried is still in flight (#3713). */
  | 'moved-send-in-flight'
  /**
   * The duplicate guard (#306): the same question was answered less than
   * `DUPLICATE_RETRY_EXPIRY_MS` ago, so it is not answered again yet. Its own
   * reason so the daily count can tell the wait for an answer to land from a stop.
   */
  | 'answered-recently';

export type LedgerWithholdReason = AutoYesSuppressionReason | LedgerOnlyWithholdReason;

/** Is the confirmation on screen (design §2.2). */
export type ConfirmationPresence = 'present' | 'gone' | 'unobservable';

/** May Auto-Yes answer it now (design §2.2). */
export type ConfirmationAnswerability = 'answerable' | 'withheld';

/** How one send came back (design §2.5). */
export type AttemptResult = 'ok' | 'partial' | 'no-keys-sent' | 'failed';

/** How a confirmation ended — an observation, not a cause (design §2.6). */
export type ConfirmationResolution =
  | 'resolved-after-answer'
  | 'resolved-while-withheld'
  | 'resolved-by-reply'
  | 'resolved-before-decision'
  | 'unresolved-after-send'
  | 'gone-while-unobservable'
  | 'abandoned';

/** Who made it go away; `unknown` unless the cause could be confirmed (design §2.6). */
export type ConfirmationResolvedBy = 'auto' | 'human-ui' | 'unknown';

/** What Auto-Yes last decided about a confirmation. */
export type ConfirmationDecision = 'answer' | 'withhold' | 'none';

/**
 * Why a withheld interval ended (design §3.3). `stopped`: Auto-Yes stopped (its
 * poller stopped: off, expired, …) while the confirmation stayed open and
 * `present` — an API approval, which is not read off the screen.
 */
export type WithholdEnd = 'answered' | 'gone' | 'unobservable' | 'stopped' | 'abandoned';

/** Fields on every ledger line. */
export interface LedgerLineBase {
  ledgerVersion: typeof AUTO_YES_LEDGER_VERSION;
  bootId: string;
  /** Server clock, epoch ms. */
  atMs: number;
}

/** One path's measured span on an `alive` line (design §4.4). */
export interface LedgerSegment {
  path: AutoYesLedgerPath;
  startMs: number;
  endMs: number;
}

export interface LedgerStartedLine extends LedgerLineBase {
  logLevel: string;
  paths: AutoYesLedgerPath[];
}

export interface LedgerAliveLine extends LedgerLineBase {
  logLevel: string;
  segments: LedgerSegment[];
  openConfirmations: number;
  openIntervals: number;
  /** Exceptions the ledger swallowed in this process, cumulative (design §8.1). */
  ledgerErrors: number;
}

export interface ConfirmationOpenedLine extends LedgerLineBase {
  confirmationId: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  source: ConfirmationSource;
  promptType: string;
  callId?: string;
  hookRequestId?: string;
  afterHookAllow?: boolean;
  afterHookAbstain?: string;
}

/** Shared by the three interval lines: an interval is found by `intervalId` alone (design §4.3). */
export interface WithholdLineBase extends LedgerLineBase {
  confirmationId: string;
  intervalId: string;
  cliToolId: CLIToolType;
  source: ConfirmationSource;
}

export interface WithholdStartedLine extends WithholdLineBase {
  reason: LedgerWithholdReason;
  startedAtMs: number;
}

export interface WithholdReasonChangedLine extends WithholdLineBase {
  from: LedgerWithholdReason;
  to: LedgerWithholdReason;
}

export interface WithholdEndedLine extends WithholdLineBase {
  startedAtMs: number;
  endedAtMs: number;
  withheldMs: number;
  end: WithholdEnd;
  lastReason: LedgerWithholdReason;
}

export interface AttemptSettledLine extends LedgerLineBase {
  confirmationId: string;
  attemptId: string;
  cliToolId: CLIToolType;
  basis: AnswerBasis;
  result: AttemptResult;
  /** The confirmation had closed before the result came back (design §2.5, N1). */
  late: boolean;
  /** The poller's send record had expired (#3713) when it came back. */
  expired: boolean;
  /** agy: the dialog was let through by a hook receipt (PR 1 marks the L3 it records). */
  receiptAccepted?: boolean;
}

export interface PresenceChangedLine extends LedgerLineBase {
  confirmationId: string;
  from: ConfirmationPresence;
  to: ConfirmationPresence;
  cause: string;
}

/** A snapshot the aggregation can rebuild an interval from with no earlier line (design §4.3). */
export interface CheckpointLine extends LedgerLineBase {
  confirmationId: string;
  cliToolId: CLIToolType;
  source: ConfirmationSource;
  presence: ConfirmationPresence;
  answerability: ConfirmationAnswerability;
  /** Closed intervals plus the open one so far. */
  withheldMsTotal: number;
  intervalId?: string;
  reason?: LedgerWithholdReason;
  intervalStartedAtMs?: number;
  intervalMs?: number;
}

export interface AttemptCounts {
  ok: number;
  partial: number;
  noKeysSent: number;
  failed: number;
}

export interface ConfirmationClosedLine extends LedgerLineBase {
  confirmationId: string;
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  source: ConfirmationSource;
  promptType: string;
  decision: ConfirmationDecision;
  basis: AnswerBasis | null;
  attempts: AttemptCounts;
  /** Sends that had not come back when it closed; their results are `late` lines. */
  attemptsPending: number;
  /** An `ok` came back before it closed (design §2.5, N1). */
  answeredAtClose: boolean;
  resolution: ConfirmationResolution;
  resolvedBy: ConfirmationResolvedBy;
  openMs: number;
  withheldMsTotal: number;
  unobservableMs: number;
  intervals: number;
  abandonReason?: string;
}

/** PR 2. `hookRequestId` is issued by the hook route only (design §2.3, N2). */
export interface HookRequestClosedLine extends LedgerLineBase {
  hookRequestId: string;
  cliToolId: CLIToolType;
  /** What the agent was answered: a reply the route could not write as decided is `abstained` (`error`). */
  outcome: 'allow' | 'abstained';
  /** The adjudicator's reason (`policy-suppressed`, `auto-yes-disabled`, …), `worktree-unresolved` or `error`. */
  abstainReason?: string;
  allowSuppressesDialog: boolean;
  replyMs: number;
  callId?: string;
  dialogUnobserved?: boolean;
}

/** PR 2. Identity stays in the log; the daily details carry counts only (design §3.4). */
export interface CliModeObservedLine extends LedgerLineBase {
  worktreeId: string;
  cliToolId: CLIToolType;
  instanceId: string;
  sessionEpoch: number;
  mode: string;
  change: 'first' | 'changed';
}

// =============================================================================
// The vocabulary as values, for a reader that must tell a known code from
// anything else (the daily aggregation, PR 4, folds the rest into `(other)`).
// Each list is the keys of a `Record` over its union, so the compiler fails
// when a member is added to the union and not here, or the other way round.
// =============================================================================

const PATHS: Record<AutoYesLedgerPath, true> = {
  screen: true,
  hook: true,
  api: true,
  'prompt-response': true,
  'agy-link': true,
};
/** Every {@link AutoYesLedgerPath}, in the order the PRs add them (design §6.4). */
export const AUTO_YES_LEDGER_PATHS = Object.keys(PATHS) as readonly AutoYesLedgerPath[];

const BASES: Record<AnswerBasis, true> = { L1: true, L2: true, L3: true, L4: true, 'enter-fallback': true, browser: true };
export const ANSWER_BASES = Object.keys(BASES) as readonly AnswerBasis[];

const WITHHOLD_REASONS: Record<LedgerWithholdReason, true> = {
  'mode-off': true,
  'deny-pattern': true,
  'deny-pattern-unusable': true,
  'type-not-allowed': true,
  'policy-lookup-failed': true,
  'agent-launch-dialog': true,
  'unclassified-frame': true,
  'partial-answer': true,
  'startup-trust-unhandled': true,
  'question-confirm-page': true,
  'no-hook-receipt': true,
  'send-failed': true,
  'send-no-keys': true,
  'foreign-session': true,
  'moved-send-in-flight': true,
  'answered-recently': true,
};
export const LEDGER_WITHHOLD_REASONS = Object.keys(WITHHOLD_REASONS) as readonly LedgerWithholdReason[];

const RESULTS: Record<AttemptResult, true> = { ok: true, partial: true, 'no-keys-sent': true, failed: true };
export const ATTEMPT_RESULTS = Object.keys(RESULTS) as readonly AttemptResult[];

const RESOLUTIONS: Record<ConfirmationResolution, true> = {
  'resolved-after-answer': true,
  'resolved-while-withheld': true,
  'resolved-by-reply': true,
  'resolved-before-decision': true,
  'unresolved-after-send': true,
  'gone-while-unobservable': true,
  abandoned: true,
};
export const CONFIRMATION_RESOLUTIONS = Object.keys(RESOLUTIONS) as readonly ConfirmationResolution[];

const RESOLVED_BY: Record<ConfirmationResolvedBy, true> = { auto: true, 'human-ui': true, unknown: true };
export const CONFIRMATION_RESOLVED_BY = Object.keys(RESOLVED_BY) as readonly ConfirmationResolvedBy[];

/**
 * Why the hook route answered a request with no decision (PR 2's
 * `abstainReason`): `PermissionDecisionReason` (`hooks/permission-decision-service.ts`)
 * less `auto-yes`, the one reason that is a decision (design §2.3).
 */
export const HOOK_ABSTAIN_REASONS = [
  'unknown-payload',
  'ask-user-question',
  'auto-yes-disabled',
  'policy-suppressed',
  'worktree-unresolved',
] as const;

/**
 * The `permission_mode` values claude's `PermissionRequest` is known to carry
 * (PR 2's `cli-mode-observed`). Another value is still logged as it came; the
 * daily aggregation counts it as `(other)` (design §6.1).
 */
export const CLI_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'bypassPermissions'] as const;
