/**
 * claude's adapter for ask attribution (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3・§6 PR1).
 *
 * For every turn in a transcript read whose prompt record carried an ask
 * envelope, or that absorbed one: the native input (the prompt record's `uuid`)
 * and session go to the ledger, and once the turn is complete — and only then —
 * it is settled against the assistant row the reader wrote for it
 * (`claude-turn:<uuid>`). A turn that took another input (M1: an absorbed
 * prompt or ask) is `ambiguous`; an ask absorbed into another turn is
 * `unmatched/absorbed_mid_turn`. A background-task notice the turn absorbed is
 * not another input (design §7 (a) ②) — the ask says `notified`.
 *
 * Turns with no envelope cost nothing here: no database read, no write.
 *
 * Never throws: History is the reader's job, and the ledger never stops it.
 */

import type { AgentInstanceRef } from '../types';
import { createLogger } from '@/lib/logger';
import { claudeTurnRequestId } from '@/types/agent-transcript';
import { CLAUDE_TURN_TRUNCATION_MARKER, type ClaudeTurnAccumulator } from './transcript';
import type { AskTurnState } from '@/lib/ask/ask-correlation';

const logger = createLogger('lib/hooks/sources/claude/ask-attribution');

/**
 * Where a claude turn stands for an ask (design §3.6 I5・H5). Only an observed
 * stop completes it — not History's write rule (`isClaudeTurnWritable`, which also
 * takes a superseded turn and one whose version writes no `stop_reason`).
 */
export function claudeAskTurnState(turn: ClaudeTurnAccumulator): AskTurnState {
  if (turn.closed) return 'closed';
  if (turn.superseded) return 'interrupted';
  return 'open';
}

/**
 * The askIds in `turns` the ledger has a reservation for under this destination
 * (I3): only their prompts lose the envelope on the way to History. Any failure
 * reads as "none" — the text then stays as the agent recorded it.
 */
export async function reservedClaudeAskIds(
  target: AgentInstanceRef,
  turns: readonly ClaudeTurnAccumulator[],
): Promise<ReadonlySet<string>> {
  const ids = turns.map((turn) => turn.askId).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return new Set();
  try {
    const [{ getDbInstance }, { getAskCorrelation }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db/ask-correlation-db'),
    ]);
    const db = getDbInstance();
    const instanceId = target.instanceId ?? target.cliToolId;
    return new Set(
      ids.filter((id) => {
        const row = getAskCorrelation(db, id);
        return row !== null
          && row.worktreeId === target.worktreeId
          && row.cliToolId === target.cliToolId
          && row.instanceId === instanceId;
      }),
    );
  } catch (error) {
    logger.warn('claude-ask-reservation-lookup-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Set();
  }
}

/** Whether any turn here has an ask to bind; the cheap check before any import. */
export function hasClaudeAskEvidence(turns: readonly ClaudeTurnAccumulator[]): boolean {
  return turns.some((turn) => Boolean(turn.askId) || (turn.absorbedAskIds?.length ?? 0) > 0);
}

/**
 * Bind the envelopes in `turns` (oldest first) to the ledger.
 *
 * @param currentSessionId - The session the instance follows now (`resolveClaudeSessionId`);
 *   a record from another session is rejected (M5)
 */
export async function bindClaudeAskTurns(
  target: AgentInstanceRef,
  turns: readonly ClaudeTurnAccumulator[],
  currentSessionId: string | null,
): Promise<void> {
  if (!hasClaudeAskEvidence(turns)) return;
  try {
    const [{ getDbInstance }, { findMessageByRequestId }, { bindAskSighting, markAskAbsorbed }] = await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db/chat-db'),
      import('@/lib/ask/ask-correlation'),
    ]);
    const db = getDbInstance();
    const destination = {
      worktreeId: target.worktreeId,
      cliToolId: target.cliToolId,
      instanceId: target.instanceId ?? target.cliToolId,
    };
    // I8・I9: an envelope on two inputs in this one read is judged a duplicate before
    // either turn's completion — the earlier sighting only records its input.
    const sightings = new Map<string, number>();
    for (const turn of turns) if (turn.askId) sightings.set(turn.askId, (sightings.get(turn.askId) ?? 0) + 1);
    const seen = new Set<string>();
    for (const turn of turns) {
      const nativeSessionId = turn.sessionId || null;
      for (const absorbedAskId of turn.absorbedAskIds ?? []) {
        if (absorbedAskId !== turn.askId) {
          markAskAbsorbed(db, absorbedAskId, destination, { nativeSessionId, currentSessionId });
        }
      }
      if (!turn.askId) continue;
      const turnKey = claudeTurnRequestId(turn.promptUuid);
      const firstOfSeveral = (sightings.get(turn.askId) ?? 0) > 1 && !seen.has(turn.askId);
      seen.add(turn.askId);
      const turnState = firstOfSeveral ? 'open' : claudeAskTurnState(turn);
      const row = turnState === 'closed' ? findMessageByRequestId(db, target.worktreeId, turnKey) : null;
      const outcome = bindAskSighting(db, {
        askId: turn.askId,
        target: destination,
        nativeInputId: turn.promptUuid,
        nativeSessionId,
        currentSessionId,
        nativeTurnKey: turnKey,
        turnState,
        otherInputs: turn.absorbedInputs ?? 0,
        notices: turn.absorbedNotices ?? 0,
        assistantMessage: row && row.role === 'assistant' ? { id: row.id, content: row.content } : null,
        truncated: row ? row.content.endsWith(CLAUDE_TURN_TRUNCATION_MARKER) : false,
      });
      logger.debug('claude-ask-sighting', { askId: turn.askId, promptUuid: turn.promptUuid, outcome });
    }
  } catch (error) {
    logger.warn('claude-ask-bind-failed', {
      worktreeId: target.worktreeId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
