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
import {
  CLAUDE_TURN_TRUNCATION_MARKER,
  isClaudeTurnWritable,
  type ClaudeTurnAccumulator,
} from './transcript';

const logger = createLogger('lib/hooks/sources/claude/ask-attribution');

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
    for (const turn of turns) {
      for (const absorbedAskId of turn.absorbedAskIds ?? []) {
        if (absorbedAskId !== turn.askId) markAskAbsorbed(db, absorbedAskId, destination);
      }
      if (!turn.askId) continue;
      const turnKey = claudeTurnRequestId(turn.promptUuid);
      const complete = isClaudeTurnWritable(turn);
      const row = complete ? findMessageByRequestId(db, target.worktreeId, turnKey) : null;
      const outcome = bindAskSighting(db, {
        askId: turn.askId,
        target: destination,
        nativeInputId: turn.promptUuid,
        nativeSessionId: turn.sessionId || null,
        currentSessionId,
        nativeTurnKey: turnKey,
        turnComplete: complete,
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
