/**
 * POST /api/worktrees/:id/send — what a refusal says about resending, from one
 * rule in the route's wrapper (Issue #4535 C4, design `send-outcome-4535.md` §2.4).
 *
 * A refusal the route made before the send service could type anything is
 * `not_sent`; the rule reads the request's state, not a list of refusals, so a
 * refusal added later is covered without touching it. `RELAY_BIND_CONFLICT` is
 * `unknown`: another attempt holds the relay, and its copy may be in.
 *
 * Its own module: the route file exports route handlers only (route-exports guard).
 */

import type { RelaySendOutcome } from '@/lib/relay/relay-bind';

/** The reservation's refusal for a relay another attempt holds (`relay-bind-db`). */
const RELAY_BIND_CONFLICT_CODE = 'RELAY_BIND_CONFLICT';

/** What the request did before its answer, as the wrapper knows it. */
export interface PreflightSendState {
  /** This request's attempt was recorded (`lastSend`), by the route or the send service. */
  attemptRecorded: boolean;
  /** The send service was entered (the input may have started). */
  serviceEntered: boolean;
  /** The service said it stopped before any key (the brief choice). */
  stoppedBeforeKeys: boolean;
}

/**
 * The `sendOutcome` the wrapper adds to `answer`, or null to add none.
 *
 * - an answer that already says `sendOutcome` (the fence's 409, a recorded attempt's): null
 * - a success: null
 * - `RELAY_BIND_CONFLICT`: `unknown`
 * - nothing recorded, and the service not entered or stopped before any key: `not_sent`
 * - otherwise null (a recorded attempt answers from its record; a failure inside
 *   the service it never placed is not claimed either way)
 */
export function preflightSendOutcome(
  answer: { status: number; body: Record<string, unknown> },
  state: PreflightSendState,
): RelaySendOutcome | null {
  if (answer.status >= 200 && answer.status < 300) return null;
  if (answer.body.sendOutcome !== undefined) return null;
  if (answer.body.code === RELAY_BIND_CONFLICT_CODE) return 'unknown';
  if (state.attemptRecorded) return null;
  if (state.serviceEntered && !state.stoppedBeforeKeys) return null;
  return 'not_sent';
}

/**
 * Issue #4535 (§3.3 I4): the answer's `sendOutcome` when the body says one and the
 * bound relay's settle says another — the weaker wins (`unknown` over any other,
 * and two that disagree are `unknown`). Absent on one side: the other.
 */
export function weakerSendOutcome(body: unknown, binding: RelaySendOutcome): RelaySendOutcome {
  if (body !== 'sent' && body !== 'not_sent' && body !== 'unknown') return binding;
  return body === binding ? binding : 'unknown';
}
