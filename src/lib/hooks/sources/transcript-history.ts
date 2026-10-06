/**
 * Helpers the per-tool transcript `history.ts` modules share.
 *
 * Each of these was written out once per tool with only the turn type's name
 * differing. The turn type is reduced to the one field these read.
 *
 * @module lib/hooks/sources/transcript-history
 */

import { stat } from 'fs/promises';
import { resolve, sep } from 'path';
import type { Logger } from '@/lib/logger';
import type { RecordedUserTurn } from '@/lib/history/user-turn-recorder';
import type { ChatMessage } from '@/types/models';
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

/**
 * The session id this instance's transcript is under, or null.
 *
 * Reads the structured event state first and falls back to the latched value.
 * The import is dynamic so that `agent-event-state`'s module graph does not
 * become a static dependency of the poller.
 *
 * @param pointers - The tool's latched session ids, keyed by `key`
 * @param key - This instance's key in `pointers`
 * @param logger - The calling tool's logger
 * @param failureEvent - The event name the tool logs when the state module is unreachable
 */
export async function resolveSessionIdFromEvents(
  target: AgentInstanceRef,
  pointers: Map<string, string>,
  key: string,
  logger: Logger,
  failureEvent: string
): Promise<string | null> {
  try {
    const { getLastAgentEvent } = await import('@/lib/session/agent-event-state');
    const sessionId = getLastAgentEvent(
      target.worktreeId,
      target.cliToolId,
      target.instanceId
    )?.sessionId;
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      pointers.set(key, sessionId);
      return sessionId;
    }
  } catch (error) {
    // A state module that cannot be reached is one that knows no session id.
    logger.debug(failureEvent, {
      worktreeId: target.worktreeId,
      instanceId: target.instanceId ?? target.cliToolId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  return pointers.get(key) ?? null;
}

/**
 * A path named by something other than the tool's module, accepted only if it
 * ends in `extension`, carries no NUL and is under `rootDir`.
 *
 * Containment is checked on the *resolved* path so that `..` cannot climb out.
 *
 * @returns The resolved path, or null when it is not acceptable
 */
export function acceptPathUnderRoot(
  rootDir: string,
  extension: string,
  candidate: string
): string | null {
  if (!candidate.endsWith(extension)) return null;
  if (candidate.includes('\0')) return null;
  const root = resolve(rootDir);
  const resolved = resolve(candidate);
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;
  return resolved;
}

/** What {@link growTurnRowTo} reads of a rendered turn. */
export interface GrowableRenderedTurn {
  readonly sessionId: string;
  readonly body: string;
  readonly textBlocks: number;
  readonly toolBlocks: number;
}

/**
 * Replace a saved row whose body has since grown (Issue #2264).
 *
 * Strictly longer, never merely different; `message_updated`, never `message`.
 *
 * @param updatedEvent - The event name the tool logs on replacement
 * @returns Whether the row was replaced
 */
export async function growTurnRowTo(
  target: AgentInstanceRef,
  existing: ChatMessage,
  rendered: GrowableRenderedTurn,
  path: string,
  logger: Logger,
  updatedEvent: string
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  // No `typeof previous !== 'string'` guard, unlike antigravity/history.ts:
  // `chat_messages.content` is `TEXT NOT NULL`, so it is always a string here.
  const previousLength = existing.content.length;
  if (rendered.body.length <= previousLength) return false;

  const [{ getDbInstance }, { updateMessageContent }, { broadcastMessage }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
    import('@/lib/ws-server'),
  ]);

  updateMessageContent(getDbInstance(), existing.id, rendered.body);
  broadcastMessage('message_updated', {
    worktreeId: target.worktreeId,
    message: { ...existing, content: rendered.body },
  });
  logger.info(updatedEvent, {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: rendered.sessionId,
    requestId: existing.requestId,
    path,
    previousLength,
    bodyLength: rendered.body.length,
    textBlocks: rendered.textBlocks,
    toolBlocks: rendered.toolBlocks,
  });
  return true;
}

/**
 * Re-read the newest already-written turns and grow the short ones (#2264).
 *
 * Turns that are still open are skipped; the database is asked before the turn
 * is rendered.
 *
 * @param candidates - Already-written turns, oldest first
 * @returns How many rows were replaced
 */
export async function refreshTurnRowsTo<T, R extends GrowableRenderedTurn>(
  target: AgentInstanceRef,
  candidates: readonly T[],
  path: string,
  tool: {
    isWritable: (turn: T) => boolean;
    requestIdOf: (turn: T) => string;
    render: (turn: T) => R;
    grow: (
      target: AgentInstanceRef,
      existing: ChatMessage,
      rendered: R,
      path: string
    ) => Promise<boolean>;
  }
): Promise<number> {
  if (candidates.length === 0) return 0;

  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  const db = getDbInstance();

  let updated = 0;
  for (const turn of candidates) {
    if (!tool.isWritable(turn)) continue;
    const existing = findMessageByRequestId(db, target.worktreeId, tool.requestIdOf(turn));
    if (!existing) continue;
    if (await tool.grow(target, existing, tool.render(turn), path)) updated += 1;
  }
  return updated;
}
