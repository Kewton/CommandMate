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
  /** `not-sent`: a prompt dialog was open (#1708). */
  | 'prompt-waiting'
  /** `not-sent`: the tmux session belongs to another server (#2865). */
  | 'foreign-session'
  /** `not-sent`: copilot's `/model` switch failed before the body. */
  | 'model-switch-failed'
  /** `not-sent`: the composer held text that could not be cleared (#1880). */
  | 'composer-not-empty'
  /** `not-sent`: a Command Code plan review overlay refused the send before the body (#3125/#3772). */
  | 'plan-review'
  /** `indeterminate`: the body was typed, did not land intact, and was taken back out best-effort (#2464/#3366). */
  | 'body-not-landed'
  /** `indeterminate`: an autocompletion replaced the body; the line was cleared best-effort (#1501). */
  | 'replaced-by-completion'
  /** `indeterminate`: the body was typed and Enter sent, but the submit was never confirmed (#1471). */
  | 'submit-unconfirmed'
  /** `indeterminate`: a read of the composer after the failure still shows the body. */
  | 'composer-residue'
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
