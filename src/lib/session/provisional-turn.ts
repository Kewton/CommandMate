/**
 * The turn fields `structuredEvents` publishes in Phase 1 (Issue #1926,
 * 方針書 §7 / §13 / §8 Phase 4).
 *
 * §7 asks `capture --json` to carry `turnId` / `openedAt` / `closedAt` /
 * `closedBy` so that `wait`'s completion gate, the header chip's elapsed time
 * and the "why did this turn end" tooltip all read one published fact instead of
 * three private ones. The layer that can answer properly — a `TurnRecord` under
 * the generation fence (§4 D3 決定 2) — is Phase 4 work, and #1899 / #1900 /
 * #1901 are in the same files right now.
 *
 * So Phase 1 lands the CONTRACT and derives its values from the single most
 * recent structured event, which is all `agent-event-state` retains today. No
 * state machine is touched, no new state is kept, and the derivation is pure.
 *
 * ## Read this before consuming `turnId`
 *
 * **It is not a stable turn identity yet.** The retained record is one event, so
 * a `pre_tool_use` arriving mid-turn re-stamps {@link ProvisionalTurn.openedAt}
 * and therefore the id. A consumer that treats a changed `turnId` as "a new turn
 * began" will false-positive several times inside one turn. That is pinned by a
 * test rather than left to be discovered, and it is exactly what the Phase 4
 * `TurnRecord` fixes.
 *
 * `wait` deliberately keeps reading `lastEventType` / `lastEventAt` until then —
 * §13 makes moving `adoptTurnStart` onto these fields a Phase 4 item and says
 * the #1839 gate stays put until the move is complete.
 */

import type { AgentEventType } from '@/lib/hooks/agent-event-types';

/**
 * The events that mean "the agent is mid-turn".
 *
 * The same three `wait.ts` adopts a turn from (`TURN_OPENING_EVENT_TYPES`), and
 * that is not a coincidence to be tidied away: these fields exist to become the
 * source `adoptTurnStart` reads in Phase 4, so a derivation that opened a turn
 * on a different set would silently change `wait`'s completion gate at the
 * moment of the switch. `tests/unit/session/status-contract-1926.test.ts` pins
 * the two sets equal — the CLI cannot import this module (`tsconfig.cli.json`
 * sets `"paths": {}`), so the pin is the only thing holding them together.
 *
 * `stop` is not here and `notification(idle_prompt)` is not either: #1839
 * measured Claude emitting `idle_prompt` 62 s into a turn that ran nothing, so
 * only `Stop` ends a turn and nothing but these three opens one.
 */
export const TURN_ACTIVITY_EVENTS: ReadonlySet<AgentEventType> = new Set<AgentEventType>([
  'user_prompt_submit',
  'pre_tool_use',
  'post_tool_use',
]);

/** The turn fields as published on `structuredEvents`. */
export interface ProvisionalTurn {
  /**
   * A stable-per-`openedAt` id for the turn, or null when no opening event is
   * the most recent one.
   *
   * See the module note: in Phase 1 this changes whenever a later turn-activity
   * event arrives, so it identifies "the turn activity we last heard about",
   * not the turn.
   */
  turnId: string | null;
  /** Epoch ms of the most recent turn-activity event, or null. */
  openedAt: number | null;
  /** Epoch ms the agent reported the turn ended, or null. */
  closedAt: number | null;
  /**
   * Why the turn ended, or null while none has.
   *
   * `'stop'` is the only value Phase 1 can produce — it is the agent's own
   * `Stop`. §7 reserves `resync_idle` / `stale` / `scraper_evidence` /
   * `generation` for the Phase 4 turn model, which is why the wire type is a
   * plain string rather than a union this build could exhaust.
   */
  closedBy: string | null;
}

/** Nothing has been reported, so nothing can be said about a turn. */
const NO_TURN: ProvisionalTurn = {
  turnId: null,
  openedAt: null,
  closedAt: null,
  closedBy: null,
};

/**
 * Derive the turn fields from the last structured event (Phase 1).
 *
 * | last event                                   | result                                        |
 * |----------------------------------------------|-----------------------------------------------|
 * | `user_prompt_submit` / `pre_tool_use` / `post_tool_use` | open: `openedAt` = its time, `turnId` from it |
 * | `stop`                                       | closed: `closedAt` = its time, `closedBy: 'stop'` |
 * | anything else, or nothing                    | all null                                      |
 *
 * The `stop` row reports no `openedAt`, and the honest reason is that this layer
 * does not know it: one event is retained, and the opening event has been
 * overwritten by the time the close arrives. Publishing a guess would be worse
 * than publishing null — `closedAt - openedAt` is the elapsed time a header chip
 * would render.
 *
 * @param lastEvent - `getLastAgentEvent`'s record, or null when none has arrived
 */
export function deriveProvisionalTurn(
  lastEvent: { event: AgentEventType; at: number } | null,
): ProvisionalTurn {
  if (lastEvent === null) return NO_TURN;

  if (TURN_ACTIVITY_EVENTS.has(lastEvent.event)) {
    return {
      turnId: `turn-${lastEvent.at}`,
      openedAt: lastEvent.at,
      closedAt: null,
      closedBy: null,
    };
  }

  if (lastEvent.event === 'stop') {
    return {
      turnId: null,
      openedAt: null,
      closedAt: lastEvent.at,
      closedBy: 'stop',
    };
  }

  return NO_TURN;
}
