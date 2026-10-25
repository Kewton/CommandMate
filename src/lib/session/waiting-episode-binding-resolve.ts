/**
 * What a new waiting episode is bound to, read from the turn model (Issue #3798).
 * Split out of `waiting-episode-binding` (Issue #3892), which re-exports it.
 *
 * @module lib/session/waiting-episode-binding-resolve
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import { currentGeneration, getAgentTurn, liveDecisionCount, toGenerationRef } from '@/lib/session/agent-event-turn';
import type { EpisodeBinding, EpisodeKeyParts, GenerationRef } from '@/lib/session/waiting-episode-state';

export function generationOf(parts: EpisodeKeyParts): GenerationRef {
  return toGenerationRef(currentGeneration(buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId)));
}

/**
 * What an episode opening now is bound to (design §2.4 規則 1).
 *
 * Read from the fenced, aged turn record — the same reading `getAgentTurn`
 * gives every other reader — with the live decisions counted without retiring
 * the expired ones, so deciding a binding writes nothing a transition would
 * later read differently.
 */
export function resolveEpisodeBinding(parts: EpisodeKeyParts, at: number): EpisodeBinding {
  const generation = generationOf(parts);
  const turn = getAgentTurn(parts.worktreeId, parts.cliToolId, parts.instanceId, at);
  if (turn === null) return { kind: 'unattributed', generation, lastClosedTurnId: null };
  if (turn.closedAt === null && turn.openedAt !== null) {
    return { kind: 'turn', generation, turnId: turn.turnId };
  }
  if (turn.closedAt === null && liveDecisionCount(turn, at) > 0) {
    return { kind: 'dialog-only', generation, recordTurnId: turn.turnId, sessionId: turn.sessionId };
  }
  // A closed turn, or a record holding no live decision (an `idle_prompt`
  // display record, or a forecast whose 20 s ran out).
  return { kind: 'unattributed', generation, lastClosedTurnId: turn.turnId };
}
