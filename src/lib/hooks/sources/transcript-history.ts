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
