/**
 * Auto-Yes's decision about the confirmation on screen, as published
 * (Issue #3821).
 *
 * The server's Auto-Yes poller is the only thing that answers a screen
 * confirmation automatically (the browser no longer does, and the Enter on an
 * unreadable screen is gone). What it decided for the confirmation it last
 * judged is published next to the prompt it was judged for, so the answer
 * surfaces know whether a human has to answer it:
 *
 * - `answering` — an automatic answer to this confirmation is under way (being
 *   sent, or sent and the screen not redrawn yet);
 * - `withheld` — Auto-Yes has left this confirmation to a human, with a
 *   `reason` (the contract, a screen it cannot read, a question, no poller
 *   running for the instance, …);
 * - `none` — no confirmation, or one not judged yet. Never read as answering.
 *
 * Client-safe: no imports but the dependency-free answer mode (Issue #3863),
 * so the browser hooks and the server read one shape.
 *
 * @module types/auto-yes-decision
 */

import type { AutoYesAnswerMode } from './auto-yes-answer-mode';

/** What Auto-Yes is doing about the confirmation on screen. */
export type AutoYesDecisionState = 'answering' | 'withheld' | 'none';

/**
 * Why a confirmation was left to a human. The poller's suppression reasons
 * (`AutoYesSuppressionReason`), the two stops only the ledger names, and the
 * reasons of this record's own:
 *
 * - `server-poller-inactive` — Auto-Yes is on for the instance, but no server
 *   poller runs for it (the concurrent poller limit refused it, for one), so
 *   nothing answers the screen;
 * - `no-auto-answer` — the base rules have no answer for the prompt (typed
 *   text, a checkbox list).
 *
 * A wire string on purpose: a newer server may name a reason this client has
 * not heard of, and that is still "withheld".
 */
export type AutoYesDecisionReason = string;

/** The reasons this record adds to the poller's suppression reasons. */
export const SERVER_POLLER_INACTIVE_DECISION_REASON = 'server-poller-inactive';
export const NO_AUTO_ANSWER_DECISION_REASON = 'no-auto-answer';

/** `autoYesDecision` on `current-output` and on the terminal push. */
export interface AutoYesDecisionPublished {
  state: AutoYesDecisionState;
  /** Set for `withheld` only. */
  reason: AutoYesDecisionReason | null;
  /**
   * Epoch ms the payload carrying this decision was built. A client receiving
   * the same window over two paths (the HTTP poll and the push) keeps the
   * later one, so a response that arrives late cannot bring back a decision a
   * newer one replaced.
   */
  observedAt: number;
  /**
   * Which confirmation the decision is about: an opaque key of the payload's
   * prompt — its question, options and approval target (the cursor on its
   * option rows aside) and, for agy, the hook call. Null with no prompt. Two
   * confirmations that read the same in their question and options but
   * approve different things carry different keys. Absent from a server
   * without the field.
   */
  confirmation?: string | null;
}

/**
 * Whether the answer panel may stay hidden under Auto-Yes for a prompt with
 * this decision: only while an automatic answer is under way. A missing
 * decision (an older server, a delivery path that did not carry it) is not
 * `answering`.
 */
export function isAutoYesAnswering(decision: Pick<AutoYesDecisionPublished, 'state'> | null | undefined): boolean {
  return decision?.state === 'answering';
}

/**
 * Of two decisions about the SAME prompt window, the one observed later
 * (Issue #3821). The HTTP poll and the push deliver the same payload over two
 * paths whose arrival order is not their build order; a decision observed
 * before the one already applied is not applied over it.
 *
 * Only for the same confirmation (`confirmation`): a window with the same
 * question and options may approve something else, and a decision about
 * another confirmation — or one that does not say which (`confirmation`
 * absent on one side only) — is dropped for the one this delivery carries,
 * whatever their times. Two without the field are compared by time.
 *
 * @param previous - What is applied now for this window, if anything
 * @param next - What this delivery carries
 */
export function laterAutoYesDecision(
  previous: AutoYesDecisionPublished | undefined,
  next: AutoYesDecisionPublished | undefined,
): AutoYesDecisionPublished | undefined {
  if (previous === undefined || next === undefined) return next;
  if ((previous.confirmation ?? null) !== (next.confirmation ?? null)) return next;
  return next.observedAt < previous.observedAt ? previous : next;
}

// The two published shapes, extended here (Issue #3821). Declared by module
// augmentation because the interfaces' own files were outside the change that
// added the field; it is the same declaration `tsc` reads either way.
declare module '@/lib/session/current-output-types' {
  interface CurrentOutputPayload {
    /**
     * Issue #3821: Auto-Yes's decision about the confirmation `promptData`
     * publishes (screen-read prompts only). Absent when the session is not
     * running, and from a server older than the field.
     */
    autoYesDecision?: AutoYesDecisionPublished;
    /**
     * Issue #3863: the answer mode of the Auto-Yes grant `autoYes` describes,
     * while it is enabled — how a question on this screen is treated
     * (`recommended`: answered with its recommended option, else its default;
     * `careful`: left to a human). Absent while Auto-Yes is off, when the
     * session is not running, and from an older server. Beside `autoYes`
     * rather than in it, for the reason `autoYesDecision` is.
     */
    autoYesAnswerMode?: AutoYesAnswerMode;
  }
}

declare module '@/lib/realtime/types' {
  interface TerminalSnapshotEvent {
    /**
     * Issue #3821: `autoYesDecision` of the same payload, straight through.
     * Absent when the session is not running and from an older server.
     */
    autoYesDecision?: AutoYesDecisionPublished;
    /**
     * Issue #3863: `autoYesAnswerMode` of the same payload, straight through.
     * Absent while Auto-Yes is off, when the session is not running, and from
     * an older server.
     */
    autoYesAnswerMode?: AutoYesAnswerMode;
  }
}
