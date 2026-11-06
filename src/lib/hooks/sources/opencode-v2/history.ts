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
 *    session ends — and, since Issue #4187, when the stream reconnects
 *    ({@link recoverOpencodeV2History}, which reads back past the newest
 *    `user` message, to the page cap).
 *
 * The screen scraper never writes a V2 reply (Issue #4187's decision): the turns
 * of a stream that is not live are this module's to write, later, under their
 * `oc-turn:` key — a scraped row cannot carry that key, so both writing would
 * double the turn. A pane with no subscription at all (`--standalone`) or one
 * whose subscription ended on its own is not recorded.
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
 * ## The model that answered
 *
 * The same read also names the model of the newest assistant message
 * (Issue #2964, {@link readLatestOpencodeV2AssistantModel}) and latches it
 * where v1's hook-borne model goes, since no `session.*` frame carries one.
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
import { recordAgentReportedModel } from '@/lib/session/agent-event-state';
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
import { OPENCODE_V2_CLI_TOOL_ID } from './tool-id';
import { getOrInitGlobal } from '../../../global-state';

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

/** `entries`' messages oldest first, as {@link buildOpencodeV2TurnsFromMessages} orders them. */
function sortOpencodeV2MessagesOldestFirst(entries: readonly unknown[]): Record<string, unknown>[] {
  return entries
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
  const messages = sortOpencodeV2MessagesOldestFirst(entries);

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

/**
 * The model the newest assistant message was answered by, or null
 * (Issue #2964).
 *
 * `assistant.model` is `{ id, providerID }` (measured on 2.0.18,
 * `tests/fixtures/opencode-v2-history-2940`). Only `id` is returned — v1's
 * `frameModel` rule (#1783): every other tool reports the bare model, and
 * `opencode/longcat-…` would make this one the odd one out.
 *
 * The reply, not the session's setting: Phase 0 saw a session created over the
 * API run on a different model from the TUI's default, so the model worth
 * showing is the one that actually answered. Newest by `time.created`, the id
 * breaking ties, the order {@link buildOpencodeV2TurnsFromMessages} uses. An
 * assistant message without a model id is skipped, not read as "unknown".
 *
 * Pure: no fetch, no state.
 */
export function readLatestOpencodeV2AssistantModel(entries: readonly unknown[]): string | null {
  let latest: { at: number; id: string; model: string } | null = null;
  for (const entry of entries) {
    if (!isPlainObject(entry) || readStringField(entry, 'type') !== 'assistant') continue;
    const model = readNestedString(entry, ['model', 'id']);
    if (model === null) continue;
    const at = createdAtOf(entry);
    const id = readStringField(entry, 'id') ?? '';
    if (latest === null || at > latest.at || (at === latest.at && id > latest.id)) {
      latest = { at, id, model };
    }
  }
  return latest?.model ?? null;
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
const queue = getOrInitGlobal('__opencodeV2HistoryQueue', () => new Map<string, Promise<unknown>>());

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

/** Whether History already holds the turn opened by this user message. */
async function isOpencodeV2TurnSaved(
  target: AgentInstanceRef,
  userMessageId: string
): Promise<boolean> {
  const [{ getDbInstance }, { findMessageByRequestId }] = await Promise.all([
    import('@/lib/db/db-instance'),
    import('@/lib/db'),
  ]);
  return (
    findMessageByRequestId(getDbInstance(), target.worktreeId, opencodeTurnRequestId(userMessageId)) !==
    null
  );
}

/** What the recovery read got back. */
interface OpencodeV2RecoveryRead {
  readonly entries: unknown[];
  /** A page could not be read (the first, or one further back). */
  readonly unreadable: boolean;
  readonly pages: number;
  /**
   * The page cap was reached with more of the document beyond it, and the
   * oldest page read held a turn History did not have, or the oldest turn read
   * lacks its `user` (its head is beyond the cap): turns further back may be
   * missing too. A long document that is all saved is not truncated.
   */
  readonly truncated: boolean;
}

/**
 * Read newest-first pages up to {@link MAX_OPENCODE_V2_HISTORY_PAGES} (or the
 * document's end) for the recovery sync (Issue #4187, C6).
 *
 * The ordinary read ({@link readRecentMessages}) stops at the first page with a
 * `user` message, so a turn that closed while the stream was down and is a page
 * further back is never read. This one does not stop at a turn History already
 * has either: no such turn marks the gap's edge for sure — an ordinary sync can
 * write a newer turn before the loss is noticed, and V2's times are another
 * clock — so it reads the whole cap, and the rows' keys (`oc-turn:<id>`) and
 * the per-instance queue keep a turn from being written twice.
 */
async function readMessagesToCap(
  target: AgentInstanceRef,
  port: number,
  password: string,
  sessionId: string
): Promise<OpencodeV2RecoveryRead> {
  const entries: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_OPENCODE_V2_HISTORY_PAGES; page += 1) {
    const result = await fetchOpencodeV2SessionMessagesPage(port, password, sessionId, cursor);
    if (result === null) return { entries, unreadable: true, pages: page, truncated: false };
    entries.push(...result.data);
    if (result.next === null || result.data.length === 0) {
      return { entries, unreadable: false, pages: page + 1, truncated: false };
    }
    if (page === MAX_OPENCODE_V2_HISTORY_PAGES - 1) {
      return {
        entries,
        unreadable: false,
        pages: page + 1,
        truncated: headUnread(entries) || (await holdsUnsavedTurn(target, result.data)),
      };
    }
    cursor = result.next;
  }
  return { entries, unreadable: false, pages: MAX_OPENCODE_V2_HISTORY_PAGES, truncated: false };
}

/**
 * Whether the oldest turn read has messages but not its head: an `assistant`
 * older than every `user` read. Its `user` is beyond the cap, so the turn
 * cannot be built (or told saved) from what was read — a turn longer than the
 * pages read included. Counted as possibly missing: without its `user` id
 * there is no way to ask History.
 */
function headUnread(entries: readonly unknown[]): boolean {
  for (const message of sortOpencodeV2MessagesOldestFirst(entries)) {
    const type = readStringField(message, 'type');
    if (type === 'user') return false;
    if (type === 'assistant') return true;
  }
  return false;
}

/** Whether `page` has a `user` message whose turn History does not have. */
async function holdsUnsavedTurn(target: AgentInstanceRef, page: unknown[]): Promise<boolean> {
  for (const entry of page) {
    if (!isPlainObject(entry) || readStringField(entry, 'type') !== 'user') continue;
    const id = readStringField(entry, 'id');
    if (id !== null && !(await isOpencodeV2TurnSaved(target, id))) return true;
  }
  return false;
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
 * Latch the answering model, then write the closed turns of `entries` that
 * History does not have, oldest first. Shared by the ordinary sync and the
 * recovery sync (Issue #4187).
 *
 * @returns How many rows were written, and how many turns History does not
 *   have the newest-kept cap dropped
 */
async function writeOpencodeV2Turns(
  target: AgentInstanceRef,
  sessionId: string,
  entries: unknown[],
  isCurrent: () => boolean
): Promise<{ written: number; droppedUnsaved: number }> {
  // Issue #2964: the model that answered, onto the hook latch the UI and
  // `capture --json` read. Before the rows, so a failed write cannot cost it.
  // Issue #3733: not for a subscription closed or replaced during the read —
  // a restarted or stopped session would show the old model, and its change
  // broadcast and Push (#2357) would fire for a session that is not there.
  // Issue #4187 (C5): the subscription's `isCurrent` also asks that the session
  // read is still the one it is following, so a late sync of the previous
  // session does not put that session's model back on the display.
  if (isCurrent()) {
    recordAgentReportedModel(
      target.worktreeId,
      OPENCODE_V2_CLI_TOOL_ID,
      target.instanceId ?? OPENCODE_V2_CLI_TOOL_ID,
      readLatestOpencodeV2AssistantModel(entries)
    );
  }

  const closed = buildOpencodeV2TurnsFromMessages(entries, sessionId).filter(
    (turn) => turn.closed
  );
  const kept = closed.slice(-MAX_OPENCODE_V2_SYNCED_TURNS);
  let droppedUnsaved = 0;
  for (const turn of closed.slice(0, closed.length - kept.length)) {
    if (!(await isOpencodeV2TurnSaved(target, turn.accumulator.userMessageId))) droppedUnsaved += 1;
  }
  let written = 0;
  // Oldest first, so the rows go in in conversation order.
  for (const turn of kept) {
    const rendered = renderOpencodeTurn(turn.accumulator);
    const at = Math.max(turn.accumulator.startedAt, turn.completedAt ?? 0);
    if (await writeOpencodeV2Turn(target, rendered, at)) written += 1;
  }
  return { written, droppedUnsaved };
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
 * @param isCurrent - Whether the subscription that asked is still the
 *   instance's (Issue #3733) and still following `sessionId` (Issue #4187);
 *   checked after the read, right before the model is latched. False skips
 *   only the latch: the rows are still written (the turn did happen, and
 *   `requestId` keeps a later sync from doubling them)
 * @returns How many rows were written
 */
export function syncOpencodeV2History(
  target: AgentInstanceRef,
  port: number,
  sessionId: string,
  isCurrent: () => boolean = () => true
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
      return (await writeOpencodeV2Turns(target, sessionId, entries, isCurrent)).written;
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

/** What one recovery sync did (Issue #4187, C7). */
export interface OpencodeV2HistoryRecoveryResult {
  /** Rows written. */
  readonly written: number;
  /**
   * The document could not be read (or the write failed), so the turns of the
   * gap may still be missing and the caller may try again. False with
   * `written: 0` means there was nothing to write.
   */
  readonly unreadable: boolean;
}

/** Options of {@link recoverOpencodeV2History}. */
export interface OpencodeV2HistoryRecoveryOptions {
  /** As {@link syncOpencodeV2History}'s `isCurrent`. */
  readonly isCurrent?: () => boolean;
}

/**
 * Record the closed turns of a session that ended while the instance's stream
 * was not live (Issue #4187, the recovery sync on reconnect).
 *
 * The same rows, keys and queue as {@link syncOpencodeV2History} — a recovery
 * and an ordinary sync that overlap still write each turn once (C8) — but read
 * {@link MAX_OPENCODE_V2_HISTORY_PAGES} pages (or to the document's end)
 * instead of to the newest `user` message (C6), never stopping early at a turn
 * History has. A warn (`opencode-v2-history-recovery-truncated`) says only that
 * turns History does not have may lie beyond the cap: the oldest page read held
 * one, the oldest turn read has no `user` in what was read, or
 * {@link MAX_OPENCODE_V2_SYNCED_TURNS} dropped one. Guaranteed: the
 * closed, unsaved turns within those pages, whatever order rows were written in
 * and whatever the clocks say — not every turn ever.
 *
 * Never throws.
 */
export function recoverOpencodeV2History(
  target: AgentInstanceRef,
  port: number,
  sessionId: string,
  options: OpencodeV2HistoryRecoveryOptions = {}
): Promise<OpencodeV2HistoryRecoveryResult> {
  const isCurrent = options.isCurrent ?? (() => true);
  return serialize(
    opencodeV2KeyOf(target),
    async (): Promise<OpencodeV2HistoryRecoveryResult> => {
      const instanceId = target.instanceId ?? target.cliToolId;
      try {
        const password = readOpencodeV2Password(target);
        if (password === null) {
          // The subscription ends on this too; nothing to try again for.
          logger.info('opencode-v2-history-unavailable', {
            worktreeId: target.worktreeId,
            instanceId,
            reason: 'password-file-missing',
          });
          return { written: 0, unreadable: false };
        }
        const read = await readMessagesToCap(target, port, password, sessionId);
        if (read.unreadable && read.entries.length === 0) {
          logger.warn('opencode-v2-history-unavailable', {
            worktreeId: target.worktreeId,
            instanceId,
            port,
            sessionId,
            reason: 'messages-unreadable',
          });
          return { written: 0, unreadable: true };
        }
        const { written, droppedUnsaved } = await writeOpencodeV2Turns(
          target,
          sessionId,
          read.entries,
          isCurrent
        );
        if (read.truncated || droppedUnsaved > 0) {
          logger.warn('opencode-v2-history-recovery-truncated', {
            worktreeId: target.worktreeId,
            instanceId,
            sessionId,
            pages: read.pages,
            droppedTurns: droppedUnsaved,
          });
        }
        return { written, unreadable: read.unreadable };
      } catch (error) {
        logger.error('opencode-v2-history-sync-failed', {
          worktreeId: target.worktreeId,
          instanceId,
          port,
          sessionId,
          recovery: true,
          error: error instanceof Error ? error.message : String(error),
        });
        return { written: 0, unreadable: true };
      }
    }
  );
}
