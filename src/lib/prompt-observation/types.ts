/**
 * The payload of one prompt observation (Issue #3755): what
 * `GET /api/worktrees/:id/current-output?observe=1` adds as `promptObservation`,
 * what `commandmate prompt --json` prints, and what `commandmate wait` adds to
 * its exit-10 payload as `observation`.
 *
 * Types only, and importable from the CLI for the reason `./kinds` gives: the
 * two imports outside this directory (`polling/auto-yes-suppression-reason`,
 * `session/send-attempt-types`) have no imports of their own.
 *
 * @module lib/prompt-observation/types
 */

import type { PromptObservationKind } from './kinds';
import type { AutoYesSuppressionReason } from '../polling/auto-yes-suppression-reason';
import type { LastSendAttempt } from '../session/send-attempt-types';

/** One option of the observed screen, in draw order. */
export interface PromptObservationOption {
  /** 1-based position on screen (the row a human would count to). */
  position: number;
  /** The label as drawn, highlight marker and number prefix removed. */
  label: string;
}

/** How the observed screen is answered today. */
export type PromptObservationAnswerVia =
  /** Keys typed at the pane through `respond` (an option number or y/n). */
  | 'screen'
  /** A decision delivered over the agent's own API (`respond <id> <number>`). */
  | 'api'
  /** agy's folder-trust screen: `respond --expect-screen` answers it (Issue #3771). */
  | 'strict'
  /** Nothing `respond` can send today: a human answers at the pane. */
  | 'terminal'
  /** There is nothing to answer (`composer` / `none`). */
  | 'none';

/**
 * Why a screen carries no token:
 * - `no-decision`: nothing asks (`composer` / `none`)
 * - `unknown-screen`: no measured reading names the screen; it is never
 *   answered by token
 * - `no-session-generation`: the server did not create the running agent (it
 *   predates a restart), so the token could not be bound to a generation
 */
export type PromptObservationTokenWithheld = 'no-decision' | 'unknown-screen' | 'no-session-generation';

/** What is on the screen, read once. */
export interface PromptObservationScreen {
  kind: PromptObservationKind;
  /**
   * The observation token (`./token`), or null — see {@link tokenWithheld}.
   * Short lived, single use, and bound to the instance, the session
   * generation, the pane, this appearance of the screen, the kind, the
   * question, the options, the approval target and the highlighted option —
   * so a sender can prove the screen it answers is the screen it read.
   *
   * Single use per appearance: the strict `respond` (#3756) consumes it BEFORE
   * sending, so a send that then fails has still burnt it (fail closed).
   *
   * Known gap: a screen that goes away and comes back with the same words
   * between two observations, with nothing observed in between, is the same
   * appearance (`./appearance`), so a token from the first still verifies.
   */
  token: string | null;
  /** Epoch ms after which the token no longer verifies; null with no token. */
  tokenExpiresAt: number | null;
  /** Why {@link token} is null; null when there is a token. */
  tokenWithheld: PromptObservationTokenWithheld | null;
  /**
   * Epoch ms this appearance of the screen was first observed (bound by the
   * token), or null when no token was issued.
   */
  appearedAt: number | null;
  /** The question as drawn, or null when the screen asks none. */
  question: string | null;
  /**
   * What the screen asks approval for: the folder on the trust screen, the
   * command block on a permission dialog. Null when the screen names none.
   *
   * A trust screen whose folder could not be read is still `antigravity-trust`,
   * with `approvalTarget: null` (and the token binds that null). A sender that
   * answers a trust screen (#3756) must require kind `antigravity-trust` AND an
   * `approvalTarget` equal to the folder it expects — a null one never matches.
   */
  approvalTarget: string | null;
  options: PromptObservationOption[];
  /** 1-based position of the highlighted option, or null when none is. */
  selectedPosition: number | null;
  answerVia: PromptObservationAnswerVia;
  /** The detector's verdict on the same frame, for diagnosis only (never a send condition). */
  sessionStatus: string;
  sessionStatusReason: string;
}

/**
 * How the poller's record relates to the screen observed now.
 *
 * The record carries a reason, a prompt type and a time — nothing that names
 * the screen it was made on — so it can never be CONFIRMED to be about this
 * screen. What can be shown is that it is not: `type-mismatch` (it was made on
 * a prompt of another type) and `no-prompt-on-screen` (nothing is asking now).
 * Every other case is `unknown`.
 */
export type PollerRecordScreenCorrelation = 'unknown' | 'type-mismatch' | 'no-prompt-on-screen';

/** The last answer the Auto-Yes poller (or the permission hook) recorded as withheld. */
export interface PromptObservationPollerRecord {
  /** As recorded. A server newer than the reader may name a reason the reader does not know. */
  reason: AutoYesSuppressionReason | string;
  mode: string | null;
  promptType: string;
  pattern?: string;
  /** Epoch ms of the record (refreshed while the poller keeps withholding). */
  at: number;
  ageSeconds: number;
  screenCorrelation: PollerRecordScreenCorrelation;
}

/**
 * The contract's Auto-Yes policy, evaluated NOW against the observed screen.
 *
 * Not what the poller did — that is {@link PromptObservationPollerRecord} —
 * and not "Auto-Yes will answer": the poller has gates of its own (the
 * tool-specific dialog reader, launch dialogs, partial answers) that this does
 * not run. `policy-permits` says only that the contract would not stop it.
 */
export type PromptObservationContractEvaluation =
  | {
      state: 'policy-withholds';
      reason: AutoYesSuppressionReason;
      pattern?: string;
      contract: PromptObservationContract | null;
    }
  | { state: 'policy-permits'; contract: PromptObservationContract | null }
  | {
      /** The base rules would not answer this prompt at all (no default, text input, checkboxes). */
      state: 'no-base-answer';
      contract: PromptObservationContract | null;
    }
  | {
      state: 'not-evaluated';
      /** `no-parsed-prompt`: the screen carries no prompt the resolver reads (selection screens, `unknown`, nothing asking). */
      because: 'no-parsed-prompt' | 'session-not-running';
      contract: PromptObservationContract | null;
    };

/** The contract governing the instance, as the policy cache read it. */
export interface PromptObservationContract {
  taskId: string | null;
  mode: string | null;
}

/** Auto-Yes as it bears on the observed screen. */
export interface PromptObservationAutoYes {
  /** Null when the session is not running (the state outlives the session; `auto-yes` serves it). */
  enabled: boolean | null;
  expiresAt: number | null;
  stopReason: string | null;
  /** Whether the server's poller for this instance is running; null when not known. */
  pollerActive: boolean | null;
  /**
   * The poller's last record, or null when it recorded nothing. **Null is not
   * "Auto-Yes can answer"**: a poller that never reached the screen records
   * nothing either (#3746 P2).
   */
  pollerRecord: PromptObservationPollerRecord | null;
  contractEvaluation: PromptObservationContractEvaluation;
}

/** One observation of one instance's screen. */
export interface PromptObservation {
  schemaVersion: number;
  /** Epoch ms the observation was made. */
  observedAt: number;
  /** The target the server resolved the request to. */
  target: {
    worktreeId: string;
    cliToolId: string;
    instanceId: string;
    /** The tmux session (pane) the frame was read from. */
    sessionName: string;
    resolvedBy: string | null;
  };
  session: {
    running: boolean;
    /** Whether the instance is still launching (`startingSince` non-null). */
    starting: boolean;
    /**
     * Epoch ms the current agent process was created by this server, or null
     * when this server did not create it (it was running before a restart).
     */
    generation: number | null;
  };
  /**
   * `observed`: the screen was read, and {@link screen} says what is on it —
   * including `composer` / `none` when nothing asks. `unavailable`: there is no
   * screen to read, and {@link screen} is null.
   */
  status: 'observed' | 'unavailable';
  unavailableReason: 'session-not-running' | null;
  screen: PromptObservationScreen | null;
  autoYes: PromptObservationAutoYes;
  /**
   * How the last send to this instance ended (Issue #3759): `not-sent` (no key
   * of the body was typed — resend it yourself), `sent`, or `indeterminate`
   * (part of it may have been typed — do not resend before checking the pane).
   * Nothing is resent automatically. Null when this server holds no record
   * (none since it started); absent from a server older than the field.
   */
  lastSend?: LastSendAttempt | null;
}

/**
 * Why the strict `respond` (Issue #3756) sent nothing (exit 40) or could not
 * say how its keys landed (exit 41).
 */
export type StrictRespondReason =
  // 40: nothing was sent
  | 'session_not_running'
  | 'capture_failed'
  | 'observation_failed'
  | 'kind_mismatch'
  | 'unsupported_screen'
  | 'no_token_on_screen'
  | 'approval_target_unreadable'
  | 'expect_target_required'
  | 'target_mismatch'
  | 'label_not_found'
  | 'label_ambiguous'
  | 'number_on_unnumbered_screen'
  | 'number_out_of_range'
  | 'selection_unreadable'
  | 'screen_not_open'
  | 'startup_window_open'
  | 'startup_trust_in_flight'
  | 'token_malformed'
  | 'token_expired'
  | 'token_not_yet_valid'
  | 'token_mismatch'
  | 'token_consumed'
  | 'token_consumed_store_full'
  // 40, decided by the CLI: the server has no strict endpoint / refused the session (409)
  | 'strict_endpoint_missing'
  | 'session_conflict'
  | 'server_unreachable'
  // 40, decided by the server: Auto-Yes is on for the instance (permission dialogs only)
  | 'auto_yes_active'
  // 41: keys were (or may have been) sent; do not send again
  | 'send_failed'
  | 'screen_moved_mid_send'
  | 'highlight_not_reached'
  | 'outcome_unchanged'
  | 'outcome_indeterminate'
  | 'operation_in_progress'
  /** The operation id was used for another request (instance, screen, answer or token). */
  | 'operation_id_conflict'
  /** Too many operations are still running to remember one more. */
  | 'operation_table_full'
  // 41, decided by the CLI: the server's answer was lost (5xx, connection)
  | 'response_unknown';

/**
 * How far the strict `respond`'s keys got: `not-sent` (none), `partial` (↑/↓
 * but not the Enter), `sent` (every key, Enter included), `indeterminate`
 * (not known — a duplicate of an operation still running).
 */
export type StrictRespondDelivery = 'not-sent' | 'partial' | 'sent' | 'indeterminate';

/**
 * What the screen did after the Enter, read again within a few seconds:
 * `unchanged` (the same screen), `advanced` (nothing asks any more: the input
 * box, or working), `next-prompt` (another measured decision screen),
 * `session-ended` (the session is gone — agy exits on the trust screen's
 * `No, exit`), `indeterminate` (could not be read, or `unknown`).
 */
export type StrictRespondOutcome = 'unchanged' | 'advanced' | 'next-prompt' | 'session-ended' | 'indeterminate';

/**
 * The body of `POST /api/worktrees/:id/prompt-response/strict`, and what
 * `commandmate respond --expect-screen … --json` prints.
 */
export interface StrictRespondResult {
  /** Always 1: the field an older server's 404 never carries. */
  strictRespond: 1;
  /** The CLI's exit code: 0 answered, 40 nothing sent, 41 sent but not confirmed (never resend). */
  code: 0 | 40 | 41;
  delivery: StrictRespondDelivery;
  /** Null when `code` is 0. */
  reason: StrictRespondReason | null;
  message: string;
  expectedKind: string;
  /** The kind the fresh capture showed; null when nothing could be read. */
  observedKind: PromptObservationKind | null;
  expectedTarget: string | null;
  /** The approval target the fresh capture showed (the folder on a trust screen). */
  observedTarget: string | null;
  operationId: string;
  /** The option the answer resolved to; null when it was not resolved. */
  answer: { position: number; label: string } | null;
  /** How many keys reached tmux. */
  keysSent: number;
  /** Null until the Enter was sent. */
  outcome: StrictRespondOutcome | null;
  /** True when this is the stored result of an earlier request with the same operation id. */
  replayed: boolean;
}
