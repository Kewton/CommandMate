/**
 * Which turn a waiting episode belongs to, and what the turn transitions do to
 * it (Issue #3798).
 *
 * The episode store (`waiting-episode-state`) knows when a wait began and what
 * it is bound to; the turn model (`agent-event-turn`) knows how each delivery
 * moved the instance's turn. This module joins the two:
 *
 *  - {@link resolveEpisodeBinding} decides what a new episode is bound to, from
 *    the turn model as it stands (design §2.4 規則 1). It is registered with the
 *    store, so an episode `observeWaitingEdge` opens is bound like any other.
 *  - {@link applyTurnOutcomesToEpisode} is the T table (design §2.4): what a
 *    transition's outcome does to the open episode. It runs in the synchronous
 *    step that recorded the delivery (`recordAgentEvent`'s end,
 *    `beginAgentEventGeneration`, the two `report*Pending`, the duplicate-window
 *    restore) and never after an `await`, so a closer that resumes later
 *    cannot reach a wait that opened meanwhile (design §2.5).
 *  - {@link captureLegacyStopTarget} / {@link settleLegacyStop} are the one
 *    closer that cannot be synchronous: `/api/hooks/claude-done` names no
 *    session and awaits a capture and a log before it is done (design 規則 6).
 *
 * The store is a leaf and does not import this module; this module registers
 * itself with the store and with the turn model through `globalThis` when it is
 * loaded. `agent-event-state` imports it, so any bundle that can record an
 * event or read a status has it (design R2-10).
 *
 * Design: `docs/design/issue-3798-waiting-episode.md`.
 *
 * @module lib/session/waiting-episode-binding
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import {
  currentGeneration,
  getAgentTurn,
  liveDecisionCount,
  registerTurnOutcomeSink,
  toGenerationRef,
  type TurnTransitionOutcome,
} from '@/lib/session/agent-event-turn';
import {
  closeEpisode,
  getWaitingEpisodeRecord,
  rebindEpisode,
  registerEpisodeBindingResolver,
  type EpisodeBinding,
  type EpisodeKeyParts,
  type GenerationRef,
  type WaitingCloseReason,
  type WaitingEpisodeId,
  type WaitingEpisodeRecord,
} from '@/lib/session/waiting-episode-state';
import { sameGeneration, verdictForOutcome, type Verdict } from '@/lib/session/waiting-episode-verdict';
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('waiting-episode-binding');

declare global {
  // eslint-disable-next-line no-var
  var __waitingHookStopGeneration: Map<string, GenerationRef> | undefined;
}

/**
 * compositeKey -> the generation in which a structured `stop` was last
 * applied. While it names the current generation, the agent's own hook speaks
 * for the end of its turns and `claude-done` does not close (規則 6).
 */
const hookStopGeneration = getOrInitGlobal('__waitingHookStopGeneration', () => new Map<string, GenerationRef>());

/** What one outcome did to the open episode. */
export interface EpisodeEffect {
  outcome: TurnTransitionOutcome['kind'];
  action: 'closed' | 'rebound' | 'none';
  episodeId: WaitingEpisodeId | null;
  reason?: WaitingCloseReason;
}

function generationOf(parts: EpisodeKeyParts): GenerationRef {
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

export { verdictForOutcome };

/** Mark that the agent's own hook reported a stop in this generation (規則 6). */
function noteHookStop(key: string, outcome: TurnTransitionOutcome): void {
  if (outcome.kind === 'stopped' || outcome.kind === 'stop-without-turn') {
    hookStopGeneration.set(key, outcome.generation);
  }
}

function applyVerdict(
  parts: EpisodeKeyParts,
  episode: WaitingEpisodeRecord,
  outcome: TurnTransitionOutcome,
  verdict: Verdict,
  at: number
): EpisodeEffect {
  const base = { outcome: outcome.kind, episodeId: episode.episodeId };
  if (verdict.action === 'close') {
    const closed = closeEpisode(parts, episode.episodeId, verdict.reason, at);
    if (closed) {
      logger.info('waiting-episode-closed-by-turn', {
        worktreeId: parts.worktreeId,
        cliToolId: parts.cliToolId,
        instanceId: parts.instanceId ?? parts.cliToolId,
        episodeId: episode.episodeId,
        outcome: outcome.kind,
        reason: verdict.reason,
      });
    }
    return { ...base, action: closed ? 'closed' : 'none', ...(closed ? { reason: verdict.reason } : {}) };
  }
  if (verdict.action === 'rebind') {
    const rebound = rebindEpisode(parts, episode.episodeId, verdict.binding, at);
    if (rebound) {
      logger.debug('waiting-episode-rebound', {
        worktreeId: parts.worktreeId,
        instanceId: parts.instanceId ?? parts.cliToolId,
        episodeId: episode.episodeId,
        outcome: outcome.kind,
        binding: verdict.binding.kind,
      });
    }
    return { ...base, action: rebound ? 'rebound' : 'none' };
  }
  if (verdict.action === 'unmatched') {
    logger.warn('waiting-episode-unmatched', {
      worktreeId: parts.worktreeId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      episodeId: episode.episodeId,
      outcome: outcome.kind,
      binding: episode.binding.kind,
    });
  }
  return { ...base, action: 'none' };
}

/**
 * Apply a delivery's transition outcomes to the instance's open episode
 * (Issue #3798, design §2.4 T table), in order.
 *
 * Called in the synchronous step that produced the outcomes. Never throws: the
 * turn has been recorded already, and a failure here must not cost the hook
 * its answer (design §2.6). An episode it leaves open is still closed by the
 * screen observers.
 *
 * @param at - Epoch ms of the change; defaults to now
 */
export function applyTurnOutcomesToEpisode(
  parts: EpisodeKeyParts,
  outcomes: readonly TurnTransitionOutcome[],
  at: number = Date.now()
): EpisodeEffect[] {
  const effects: EpisodeEffect[] = [];
  try {
    const key = buildCompositeKey(parts.worktreeId, parts.cliToolId, parts.instanceId);
    for (const outcome of outcomes) {
      noteHookStop(key, outcome);
      const episode = getWaitingEpisodeRecord(parts.worktreeId, parts.cliToolId, parts.instanceId);
      if (episode === null) {
        effects.push({ outcome: outcome.kind, action: 'none', episodeId: null });
        continue;
      }
      const verdict = verdictForOutcome(outcome, episode.binding, generationOf(parts));
      effects.push(applyVerdict(parts, episode, outcome, verdict, at));
    }
  } catch (error) {
    logger.warn('waiting-episode-turn-sync-failed', {
      worktreeId: parts.worktreeId,
      instanceId: parts.instanceId ?? parts.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return effects;
}

// =============================================================================
// claude-done (design 規則 6)
// =============================================================================

/** What `claude-done` decided about when it arrived. */
export interface LegacyStopTarget {
  generation: GenerationRef;
  episodeId: WaitingEpisodeId | null;
}

/**
 * Fix the episode a legacy (`claude-done`) stop is about, before its first
 * capture `await` (design 規則 6). The body read before it cannot be helped: the
 * worktree id is in the body — a known limit (design §8).
 */
export function captureLegacyStopTarget(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): LegacyStopTarget {
  const parts = { worktreeId, cliToolId, instanceId };
  return {
    generation: generationOf(parts),
    episodeId: getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId)?.episodeId ?? null,
  };
}

export type LegacyStopSettlement = 'closed' | 'target-gone' | 'hook-authority' | 'screen' | 'nothing-open';

/**
 * Close the episode a legacy stop was fixed on, if it is still the open one
 * (design 規則 6). Nothing when the hook reported a stop in this generation
 * (the hook speaks for the end of turns; closing again is the double close the
 * rule forbids), when another episode opened meanwhile, or for a screen only a
 * person drives.
 *
 * @param at - Epoch ms; defaults to now
 */
export function settleLegacyStop(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  target: LegacyStopTarget,
  at: number = Date.now()
): LegacyStopSettlement {
  try {
    const parts = { worktreeId, cliToolId, instanceId };
    const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
    const episode = getWaitingEpisodeRecord(worktreeId, cliToolId, instanceId);
    if (episode === null) return 'nothing-open';
    const current = generationOf(parts);
    if (
      target.episodeId === null ||
      episode.episodeId !== target.episodeId ||
      !sameGeneration(target.generation, current)
    ) {
      return 'target-gone';
    }
    const hookStop = hookStopGeneration.get(key);
    if (hookStop !== undefined && sameGeneration(hookStop, current)) return 'hook-authority';
    if (episode.binding.kind === 'screen') return 'screen';
    return closeEpisode(parts, episode.episodeId, 'legacy-stop', at) ? 'closed' : 'target-gone';
  } catch (error) {
    logger.warn('waiting-episode-legacy-stop-failed', {
      worktreeId,
      instanceId: instanceId ?? cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
    return 'nothing-open';
  }
}

/** Forget the hook-stop marks. Test seam, called by `clearAgentStopEvents`. */
export function clearWaitingEpisodeBindingState(): void {
  hookStopGeneration.clear();
}

registerEpisodeBindingResolver(resolveEpisodeBinding);
registerTurnOutcomeSink((parts, outcomes) => {
  applyTurnOutcomesToEpisode(parts, outcomes);
});
