/**
 * What the last send to an instance did to its pane (Issue #3759): types only.
 *
 * Kept free of imports so the CLI can read the payload's shape through
 * `lib/prompt-observation/types` without pulling the server graph in (the same
 * rule `polling/auto-yes-suppression-reason` follows).
 *
 * @module lib/session/send-attempt-types
 */

/**
 * - `not-sent`: it failed before any key of the message body was typed (the
 *   input prompt never came back, a dialog was open, the session was another
 *   server's). The message is not on the pane.
 * - `sent`: the body was typed and its submit was confirmed.
 * - `indeterminate`: it failed after part of the body may have been typed, or
 *   its outcome could not be read back. The message may be in the composer, or
 *   may even have been submitted.
 *
 * Nothing is resent automatically in any state. A `not-sent` message is the
 * sender's to resend; an `indeterminate` one must not be resent before the pane
 * has been looked at (`capture --pane`), or it can arrive twice.
 */
export type SendAttemptState = 'not-sent' | 'sent' | 'indeterminate';

export type SendAttemptReason =
  /** `sent`: the submit was confirmed. */
  | 'submitted'
  /** `not-sent`: the input prompt did not appear within the wait (#3746). */
  | 'prompt-not-ready'
  /** `not-sent`: the session was launched and is still coming up. */
  | 'session-starting'
  /** `not-sent`: the session could not be started. */
  | 'session-start-failed'
  /** `not-sent`: a prompt dialog was open (#1708), or opened while the send waited for the composer (#3945). */
  | 'prompt-waiting'
  /** `not-sent`: the tmux session belongs to another server (#2865). */
  | 'foreign-session'
  /** `not-sent`: copilot's `/model` switch failed before the body. */
  | 'model-switch-failed'
  /** `not-sent`: the composer held text that could not be cleared (#1880). */
  | 'composer-not-empty'
  /** `not-sent`: a Command Code plan review overlay refused the send before the body (#3125/#3772). */
  | 'plan-review'
  /** `not-sent`: another send held the instance's composer past the input lock's wait (#3945). */
  | 'input-lock-timeout'
  /** `not-sent`: the session was killed or recreated while the send waited for its composer (#3945). */
  | 'session-replaced'
  /** `not-sent`: the composer was handed to another writer before the body was typed (#3945). */
  | 'input-lock-lost'
  /**
   * `not-sent`: the bound relay the send was going in under was no longer its
   * own right before the first key (cancelled, expired or taken), so the
   * input-boundary hook refused it and nothing was typed or dispatched (#3957/#3992).
   */
  | 'relay-reservation-lost'
  /** `not-sent`: the pane could not be re-read under the input lock, so nothing was typed (#3945). */
  | 'recheck-failed'
  /**
   * `not-sent`: a body sent as one paste could not be loaded into the tmux
   * buffer (`load-buffer` failed), so `paste-buffer` never ran and nothing of
   * the body reached the pane (#4011/#4031).
   */
  | 'paste-not-started'
  /** `indeterminate`: the body was typed, did not land intact, and was taken back out best-effort (#2464/#3366). */
  | 'body-not-landed'
  /** `indeterminate`: an autocompletion replaced the body; the line was cleared best-effort (#1501). */
  | 'replaced-by-completion'
  /** `indeterminate`: the body was typed and Enter sent, but the submit was never confirmed (#1471). */
  | 'submit-unconfirmed'
  /** `indeterminate`: a read of the composer after the failure still shows the body. */
  | 'composer-residue'
  /**
   * `indeterminate`: the composer did not show the body after Enter, but the
   * agent did not report the session's first prompt either (#4035).
   */
  | 'prompt-unreported'
  /**
   * `indeterminate`: a send reported `sent`, and the next send found that body
   * still in the composer before typing its own (#4035).
   */
  | 'found-in-composer'
  /** `indeterminate`: any other failure; where it stopped is not known. */
  | 'send-error';

/** The last send attempt as `prompt --json` publishes it (`lastSend`). */
export interface LastSendAttempt {
  /** Epoch ms the attempt ended. */
  at: number;
  state: SendAttemptState;
  /** As recorded. A server newer than the reader may name a reason the reader does not know. */
  reason: SendAttemptReason | string;
}

/**
 * `code` on the error a tool throws when a plan review overlay refuses the
 * send before any body is typed (Issue #3772). Matched by code, never by wording.
 */
export const PLAN_REVIEW_SEND_REFUSED_CODE = 'PLAN_REVIEW_SEND_REFUSED';

/**
 * `code` on the error a long body's paste throws when `load-buffer` failed
 * (Issue #4031): `paste-buffer` never ran, so none of the body reached the
 * pane. The tools wrap the error (`Failed to send message to <tool>: …`) with
 * it as `cause`, and the send's outcome is read off that chain by code — the
 * wording is shared with nothing, but a `paste-buffer` failure's is
 * (`Failed to paste message into tmux session`) and that one is not known safe.
 */
export const PASTE_NOT_STARTED_CODE = 'PASTE_NOT_STARTED';

/**
 * `code` on the errors the input re-check throws before any key
 * (`recheckComposerBeforeInput`, Issue #3952): a dialog was open, or the pane
 * could not be read. Carried by copilot's `/model` switch, whose caller records
 * the reason by code rather than by the wording around it.
 */
export const INPUT_RECHECK_PROMPT_WAITING_CODE = 'INPUT_RECHECK_PROMPT_WAITING';
export const INPUT_RECHECK_FAILED_CODE = 'INPUT_RECHECK_FAILED';
