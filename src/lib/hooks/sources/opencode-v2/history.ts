/**
 * Writing OpenCode V2's replies into conversation history (Issue #2940,
 * Epic #2370 Phase 2's transcript, brought forward).
 *
 * Before this, the screen scraper was the only writer of an `opencode-v2`
 * reply, and it never wrote one: its completion test is the home screen's
 * composer placeholder (`Ask anything…`), which OpenCode V2 draws only before
 * the first prompt. So History held the user's prompts and none of the
 * answers.
 *
 * ## Pull on the turn's end, not a reassembled stream
 *
 * The SSE stream does carry the reply (`session.text.started|delta|ended`,
 * `session.reasoning.*`, `session.tool.*`), but this reads it from
 * `GET /api/session/{id}/message` instead, once the stream says the turn is
 * over (`session.execution.succeeded` / `failed` / `interrupted`):
 *
 *  - the document is the finished turn as the server stored it — no delta to
 *    reassemble, no frame whose loss corrupts a row, and nothing held in
 *    memory between frames;
 *  - it is idempotent by construction: every turn is keyed on its user
 *    message's id, so a repeated end-of-turn frame, a reconnect or two turns
 *    ending close together write each turn once;
 *  - and it recovers what the stream missed. A turn that ended while the
 *    connection was down is in the document the next time any turn of the
 *    session ends.
 *
 * ## One turn in the document
 *
 * Measured on 2.0.18 (`tests/fixtures/opencode-v2-history-2940`): messages are
 * typed, and one turn is a `user` message, then one `assistant` message per
 * model step (a tool-calling turn has several), then an `idle` message with the
 * turn's `outcome`. Assistant messages carry no parent id, so the turn is
 * recovered from the order alone: a turn opens at its `user` message and is
 * closed by the `idle` that follows, or by the next `user` message. A turn that
 * is still open is not written — the next end-of-turn reads it again.
 *
 * ## One row, one writer
 *
 * The row is `assistant` / `normal`, keyed `oc-turn:<user message id>` — the
 * same key family v1's reader uses (`opencodeTurnRequestId`), so every surface
 * that recognises an agent-authored turn recognises this one. The scraper
 * stands down while the subscription is live
 * (`isOpencodeV2StructuredHistoryLive`, via `lib/polling/structured-history-gate`).
 *
 * The body is rendered by v1's `renderOpencodeTurn` from the same part shape,
 * so the text, the folded reasoning and the one-line tool summary look exactly
 * like an OpenCode (v1) reply (#2041 / #2234 / #2272).
 *
 * ## Nothing here throws
 *
 * A failed fetch or write costs the row, never the subscription: the state the
 * stream publishes is independent of it, and the scraper is no worse off than
 * before. Database imports are dynamic for the reason v1's `./history` gives.
 *
 * @module lib/hooks/sources/opencode-v2/history
 */

import { createLogger } from '@/lib/logger';
import { opencodeTurnRequestId } from '@/types/agent-transcript';
import { isPlainObject, readNestedString, readStringField } from '../event-mapper';
import {
  addOpencodePart,
  createOpencodeTurn,
  renderOpencodeTurn,
  type OpencodeRenderedTurn,
  type OpencodeTranscriptPart,
  type OpencodeTurnAccumulator,
} from '../opencode/transcript';
import type { AgentInstanceRef } from '../types';
import { fetchOpencodeV2SessionMessagesPage } from './client';
import { opencodeV2KeyOf, readOpencodeV2Password } from './secrets';

const logger = createLogger('lib/hooks/sources/opencode-v2/history');

/** The stream events after which a turn's reply is read (Issue #2940). */
export const OPENCODE_V2_TURN_END_EVENT_TYPES: readonly string[] = [
  'session.execution.succeeded',
  'session.execution.failed',
  'session.execution.interrupted',
];

/** Whether a frame `type` ends a turn. */
export function isOpencodeV2TurnEndEventType(type: string | null): boolean {
  return type !== null && OPENCODE_V2_TURN_END_EVENT_TYPES.includes(type);
}

/**
 * Pages read, newest first, while looking for the newest turn's `user`
 * message. A turn is one assistant message per model step, so one page of
 * {@link OPENCODE_V2_MESSAGES_PAGE_SIZE} covers all but a very long tool loop;
 * the bound keeps a session that never shows a `user` message from being read
 * to the end.
 */
export const MAX_OPENCODE_V2_HISTORY_PAGES = 5;

/** Cap on turns one sync writes, newest kept. */
export const MAX_OPENCODE_V2_SYNCED_TURNS = 50;

/** One turn rebuilt from the message document. */
export interface OpencodeV2Turn {
  /** The accumulator v1's renderer reads. */
  readonly accumulator: OpencodeTurnAccumulator;
  /** Whether an `idle` or a later `user` message closed it. */
  readonly closed: boolean;
  /** When the last assistant message finished, epoch ms; null when none said. */
  readonly completedAt: number | null;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function createdAtOf(message: Record<string, unknown>): number {
  const time = isPlainObject(message.time) ? message.time : null;
  return readFiniteNumber(time?.created) ?? 0;
}

/**
 * One element of an assistant message's `content`, as v1's part shape.
 *
 * v2's content items have no id of their own (a tool item's `id` is the
 * provider's call id), so the slot is `<message id>#<index>`, which is stable
 * across re-reads of the same stored message.
 */
export function readOpencodeV2ContentPart(
  messageId: string,
  index: number,
  item: unknown
): OpencodeTranscriptPart | null {
  if (!isPlainObject(item)) return null;
  const type = readStringField(item, 'type');
  if (!type) return null;
  const state = isPlainObject(item.state) ? item.state : null;
  return {
    id: `${messageId}#${index}`,
    messageId,
    type,
    text: typeof item.text === 'string' ? item.text : null,
    tool: type === 'tool' ? readStringField(item, 'name') : null,
    status: state ? readStringField(state, 'status') : null,
    title: state ? readStringField(state, 'title') : null,
    error: state
      ? (readStringField(state, 'error') ?? readNestedString(state, ['error', 'message']))
      : null,
  };
}

/**
 * Rebuild the turns of a session from `GET /api/session/{id}/message` entries.
 *
 * Order-agnostic: the entries are sorted oldest first by `time.created` (the
 * id, which is time-ordered, breaks ties), so a desc page, an asc page or
 * several pages concatenated give the same turns. Assistant messages before the
 * first `user` message belong to a turn whose head is outside what was read,
 * and are dropped rather than attached to nothing.
 *
 * Pure: no fetch, no database.
 */
export function buildOpencodeV2TurnsFromMessages(
  entries: readonly unknown[],
  sessionId: string
): OpencodeV2Turn[] {
  const messages = entries
    .filter(isPlainObject)
    .filter((message) => readStringField(message, 'id') !== null)
    .map((message, index) => ({ message, index }))
    .sort((a, b) => {
      const byTime = createdAtOf(a.message) - createdAtOf(b.message);
      if (byTime !== 0) return byTime;
      const aId = readStringField(a.message, 'id') ?? '';
      const bId = readStringField(b.message, 'id') ?? '';
      return aId < bId ? -1 : aId > bId ? 1 : a.index - b.index;
    })
    .map(({ message }) => message);

  const turns: OpencodeV2Turn[] = [];
  let open: { accumulator: OpencodeTurnAccumulator; completedAt: number | null } | null = null;
  const close = (closed: boolean): void => {
    if (open) turns.push({ ...open, closed });
    open = null;
  };

  for (const message of messages) {
    const id = readStringField(message, 'id') as string;
    const type = readStringField(message, 'type');
    if (type === 'user') {
      close(true);
      open = {
        accumulator: createOpencodeTurn(sessionId, id, createdAtOf(message)),
        completedAt: null,
      };
      continue;
    }
    if (!open) continue;
    const current: { accumulator: OpencodeTurnAccumulator; completedAt: number | null } = open;
    if (type === 'idle') {
      close(true);
      continue;
    }
    if (type !== 'assistant') continue;
    current.accumulator.assistantMessageIds.add(id);
    const content = Array.isArray(message.content) ? message.content : [];
    content.forEach((item, index) => {
      const part = readOpencodeV2ContentPart(id, index, item);
      if (part) addOpencodePart(current.accumulator, part);
    });
    const time = isPlainObject(message.time) ? message.time : null;
    const finished = readFiniteNumber(time?.completed) ?? readFiniteNumber(time?.created);
    if (finished !== null && finished > (current.completedAt ?? 0)) current.completedAt = finished;
  }
  close(false);
  return turns;
}

declare global {
  // eslint-disable-next-line no-var
  var __opencodeV2HistoryQueue: Map<string, Promise<unknown>> | undefined;
}

/**
 * One sync at a time per instance, on `globalThis` for #1736's reason. Two turn
 * ends close together would otherwise race the existence check and insert the
 * same turn twice.
 */
const queue = (globalThis.__opencodeV2HistoryQueue ??= new Map<string, Promise<unknown>>());

/** Forget queued syncs. Test seam. */
export function resetOpencodeV2HistoryQueue(): void {
  queue.clear();
}

function serialize<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = queue.get(key) ?? Promise.resolve();
  const result = previous.then(work, work);
  const settled = result.then(
    () => undefined,
    () => undefined
  );
  queue.set(key, settled);
  void settled.then(() => {
    if (queue.get(key) === settled) queue.delete(key);
  });
  return result;
}

/** Read newest-first pages until the newest turn's `user` message is in view. */
async function readRecentMessages(
  port: number,
  password: string,
  sessionId: string
): Promise<unknown[] | null> {
  const entries: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_OPENCODE_V2_HISTORY_PAGES; page += 1) {
    const result = await fetchOpencodeV2SessionMessagesPage(port, password, sessionId, cursor);
    if (result === null) return page === 0 ? null : entries;
    entries.push(...result.data);
    const sawUser = result.data.some(
      (entry) => isPlainObject(entry) && readStringField(entry, 'type') === 'user'
    );
    if (sawUser || result.next === null || result.data.length === 0) break;
    cursor = result.next;
  }
  return entries;
}

/**
 * Write one rendered turn, unless its row is already there.
 *
 * @returns Whether a row was written
 */
async function writeOpencodeV2Turn(
  target: AgentInstanceRef,
  rendered: OpencodeRenderedTurn,
  timestampMs: number
): Promise<boolean> {
  const instanceId = target.instanceId ?? target.cliToolId;
  if (rendered.body.length === 0) {
    logger.info('opencode-v2-history-turn-empty', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
    });
    return false;
  }
  if (rendered.unknownPartTypes.length > 0) {
    logger.info('opencode-v2-history-unknown-parts', {
      worktreeId: target.worktreeId,
      instanceId,
      sessionId: rendered.sessionId,
      partTypes: rendered.unknownPartTypes,
    });
  }

  const requestId = opencodeTurnRequestId(rendered.userMessageId);
  const [{ getDbInstance }, { createMessage, findMessageByRequestId }, { broadcastMessage }] =
    await Promise.all([
      import('@/lib/db/db-instance'),
      import('@/lib/db'),
      import('@/lib/ws-server'),
    ]);
  const db = getDbInstance();
  if (findMessageByRequestId(db, target.worktreeId, requestId)) return false;

  const message = createMessage(db, {
    worktreeId: target.worktreeId,
    role: 'assistant',
    content: rendered.body,
    messageType: 'normal',
    timestamp: new Date(timestampMs > 0 ? timestampMs : Date.now()),
    cliToolId: target.cliToolId,
    instanceId,
    requestId,
  });
  broadcastMessage('message', { worktreeId: target.worktreeId, message });
  logger.info('opencode-v2-history-turn-saved', {
    worktreeId: target.worktreeId,
    instanceId,
    sessionId: rendered.sessionId,
    requestId,
    bodyLength: rendered.body.length,
    textParts: rendered.textParts,
    toolParts: rendered.toolParts,
  });
  return true;
}

/**
 * Record every closed turn of a session that History does not have yet.
 *
 * Called when the instance's stream says a turn of `sessionId` ended. Never
 * throws; a failure is logged and costs only the rows.
 *
 * @param target - The instance the stream belongs to
 * @param port - Its server
 * @param sessionId - `ses_…` from the end-of-turn frame
 * @returns How many rows were written
 */
export function syncOpencodeV2History(
  target: AgentInstanceRef,
  port: number,
  sessionId: string
): Promise<number> {
  return serialize(opencodeV2KeyOf(target), async (): Promise<number> => {
    const instanceId = target.instanceId ?? target.cliToolId;
    try {
      const password = readOpencodeV2Password(target);
      if (password === null) {
        logger.info('opencode-v2-history-unavailable', {
          worktreeId: target.worktreeId,
          instanceId,
          reason: 'password-file-missing',
        });
        return 0;
      }
      const entries = await readRecentMessages(port, password, sessionId);
      if (entries === null) {
        logger.warn('opencode-v2-history-unavailable', {
          worktreeId: target.worktreeId,
          instanceId,
          port,
          sessionId,
          reason: 'messages-unreadable',
        });
        return 0;
      }

      const closed = buildOpencodeV2TurnsFromMessages(entries, sessionId).filter(
        (turn) => turn.closed
      );
      const kept = closed.slice(-MAX_OPENCODE_V2_SYNCED_TURNS);
      let written = 0;
      // Oldest first, so the rows go in in conversation order.
      for (const turn of kept) {
        const rendered = renderOpencodeTurn(turn.accumulator);
        const at = Math.max(turn.accumulator.startedAt, turn.completedAt ?? 0);
        if (await writeOpencodeV2Turn(target, rendered, at)) written += 1;
      }
      return written;
    } catch (error) {
      logger.error('opencode-v2-history-sync-failed', {
        worktreeId: target.worktreeId,
        instanceId,
        port,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    }
  });
}
