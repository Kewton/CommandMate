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

/** The level of evidence an answer was given on (design §0). */
export type AnswerBasis = 'L1' | 'L2' | 'L3' | 'L4' | 'enter-fallback' | 'browser';

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

/** Why a withheld interval ended (design §3.3). */
export type WithholdEnd = 'answered' | 'gone' | 'unobservable' | 'abandoned';

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
  outcome: 'allow' | 'abstained';
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
