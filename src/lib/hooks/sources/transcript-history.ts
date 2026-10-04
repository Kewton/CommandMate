/**
 * Helpers the per-tool transcript `history.ts` modules share.
 *
 * Each of these was written out once per tool with only the turn type's name
 * differing. The turn type is reduced to the one field these read.
 *
 * @module lib/hooks/sources/transcript-history
 */

import { stat } from 'fs/promises';
import type { RecordedUserTurn } from '@/lib/history/user-turn-recorder';
import type { AgentInstanceRef } from './types';

/**
 * When the assistant row for this turn is dated.
 *
 * **The turn's LAST assistant record, not its prompt (Issue #2273).** #2121
 * dated the reply by the prompt record's clock so that a row written a poll late
 * still sorted where the conversation put it, and #2196 moved it one millisecond
 * on so that `groupMessagesIntoPairs` — which orders by timestamp and nothing
 * else — could never return the answer above the question. Both properties
 * survive: `earliest` is a floor this never goes under.
 *
 * What neither accounted for is the row that lands BETWEEN the prompt and the
 * reply. A tool approval is written when the dialog appears, seconds into the
 * turn, and the chat surface orders its rows by timestamp — so a reply dated at
 * the turn's start draws ABOVE an approval that really happened before it. The
 * measured case is in the Issue: prompt `04:49:50.989Z`, reply `04:49:54.000Z`,
 * approval `04:49:57.513Z`, rendered as question → answer → approval.
 *
 * The turn's last assistant record is the moment the reply was finished, so
 * everything the turn produced on the way sorts before it. `lastRecordAt` is 0
 * when the window held no timestamped assistant record for the turn, and the row
 * is then dated exactly where #2196 put it.
 *
 * `nextTurnOpensAt` is the ceiling. The next turn's prompt row may be a `/send`
 * row written while THIS turn was still running — a queued prompt — and a reply
 * that overtook it would be paired with the wrong question.
 *
 * @param lastRecordAt - Epoch ms of the turn's last assistant record, or 0
 * @param nextTurnOpensAt - Epoch ms of the next turn's user row, or null when
 *   this is the newest turn in the window
 */
export function resolveAssistantTimestampMs(
  turn: { startedAt: number },
  userRow: RecordedUserTurn,
  lastRecordAt = 0,
  nextTurnOpensAt: number | null = null
): number {
  const earliest =
    userRow.timestampMs === null
      ? turn.startedAt
      : Math.max(turn.startedAt, userRow.timestampMs + 1);
  const latest = nextTurnOpensAt === null ? Number.POSITIVE_INFINITY : nextTurnOpensAt - 1;
  return Math.max(earliest, Math.min(lastRecordAt, latest));
}

/**
 * The instant the next pending turn's prompt row carries, or null (Issue #2273).
 *
 * The user row's own timestamp when there is one, because that is what History
 * sorts on and it can be EARLIER than the turn's start — an adopted `/send` row
 * was written when CommandMate handed the text to the pane, which for a queued
 * prompt is while the previous turn was still running. The turn's start is the
 * fallback for a turn that produced no row at all.
 */
export function nextTurnOpensAt(
  turns: readonly { startedAt: number }[],
  userRows: readonly RecordedUserTurn[],
  index: number
): number | null {
  const next = turns[index + 1];
  if (!next) return null;
  return userRows[index + 1]?.timestampMs ?? next.startedAt;
}

export async function isReadableFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** What {@link selectUnwrittenTurns} answers. */
export interface PendingTurns<T extends { startedAt: number }> {
  /** The turns to write, oldest first. Empty when the newest one is a row. */
  readonly turns: readonly T[];
  /** `startedAt` of the turn immediately before the first pending one, or 0. */
  readonly previousStartedAt: number;
  /** Whether a written turn was found in the window. Logged, never branched on. */
  readonly anchored: boolean;
}

/**
 * The turns still to write: search backwards from the newest turn for one that
 * is already a row, and take everything after it (Issue #2246).
 *
 * Record order and never a timestamp. A window with no anchor answers with the
 * newest turn alone. The tools differ only in how a turn's request id is built.
 *
 * @param turns - Every turn in the window, oldest first
 * @param requestIdOf - The request id the tool records a turn's user row under
 */
export async function selectUnwrittenTurns<T extends { startedAt: number }>(
  target: AgentInstanceRef,
  turns: readonly T[],
  requestIdOf: (turn: T) => string
): Promise<PendingTurns<T>> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const requestId = requestIdOf(turns[index]);
    if (!findMessageByRequestId(db, target.worktreeId, requestId)) continue;
    return {
      turns: turns.slice(index + 1),
      previousStartedAt: turns[index].startedAt,
      anchored: true,
    };
  }

  return {
    turns: turns.slice(-1),
    previousStartedAt: turns.length > 1 ? turns[turns.length - 2].startedAt : 0,
    anchored: false,
  };
}
