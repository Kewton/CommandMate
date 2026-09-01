/**
 * Chat message database operations
 * CRUD operations for chat_messages table
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';
import type { ChatMessage, MessageType, PromptAnsweredBy, PromptData } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('chat-db');

/** Active (non-archived) message filter clause. Single point of change for archived filtering. */
export const ACTIVE_FILTER = 'AND archived = 0';

/** Options for getMessages query */
export interface GetMessagesOptions {
  before?: Date;
  limit?: number;
  cliToolId?: CLIToolType;
  /** Issue #868: scope to a single agent instance (overrides cliToolId filtering when set). */
  instanceId?: string;
  includeArchived?: boolean;
  /**
   * Issue #1685: restrict results to a single message_type. Used with 'prompt'
   * by the CLI prompt-audit listing (`capture --prompts`). Note that legacy rows
   * store NULL for 'normal', so filtering on 'normal' misses pre-#565 rows —
   * only the 'prompt' filter has a consumer today.
   */
  messageType?: MessageType;
  /**
   * Issue #1407: unit that `limit` counts.
   * - 'messages' (default): bounds the number of raw chat rows returned (legacy behavior).
   * - 'pairs': bounds the number of conversation turns. The newest `limit` user
   *   messages in scope are located and every row at or after the oldest of them is
   *   returned, so grouping into conversation pairs yields up to `limit` cards
   *   regardless of how many assistant rows each turn produced (e.g. codex prompts).
   */
  limitUnit?: 'messages' | 'pairs';
}

type ChatMessageRow = {
  id: string;
  worktree_id: string;
  role: 'user' | 'assistant';
  content: string;
  summary: string | null;
  timestamp: number;
  log_file_name: string | null;
  request_id: string | null;
  message_type: string | null;
  prompt_data: string | null;
  cli_tool_id: string | null;
  instance_id: string | null;
  archived: number;
};

function mapChatMessage(row: ChatMessageRow): ChatMessage {
  const cliToolId = (row.cli_tool_id as CLIToolType | null) ?? 'claude';
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    role: row.role,
    content: row.content,
    summary: row.summary || undefined,
    timestamp: new Date(row.timestamp),
    logFileName: row.log_file_name || undefined,
    requestId: row.request_id || undefined,
    messageType: (row.message_type as 'normal' | 'prompt') || 'normal',
    promptData: row.prompt_data ? JSON.parse(row.prompt_data) : undefined,
    cliToolId,
    instanceId: row.instance_id ?? cliToolId,
    archived: row.archived === 1,
  };
}

/**
 * Update worktree's updated_at timestamp
 * @private
 */
function updateWorktreeTimestamp(
  db: Database.Database,
  worktreeId: string,
  timestamp: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET updated_at = ?
    WHERE id = ?
  `);

  stmt.run(timestamp.getTime(), worktreeId);
}

/**
 * Get the timestamp of the most recent assistant message for a worktree
 * Used for unread tracking (Issue #31)
 */
export function getLastAssistantMessageAt(
  db: Database.Database,
  worktreeId: string
): Date | null {
  const stmt = db.prepare(`
    SELECT MAX(timestamp) as last_assistant_message_at
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'assistant' ${ACTIVE_FILTER}
  `);

  const row = stmt.get(worktreeId) as { last_assistant_message_at: number | null } | undefined;

  if (!row || row.last_assistant_message_at === null) {
    return null;
  }

  return new Date(row.last_assistant_message_at);
}

/**
 * Create a new chat message
 */
export function createMessage(
  db: Database.Database,
  message: Omit<ChatMessage, 'id' | 'archived'>
): ChatMessage {
  const id = randomUUID();

  const cliToolId = message.cliToolId || 'claude';
  // Issue #868: instance_id defaults to the primary instance (=== cliToolId).
  const instanceId = message.instanceId || cliToolId;

  const stmt = db.prepare(`
    INSERT INTO chat_messages
    (id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    id,
    message.worktreeId,
    message.role,
    message.content,
    message.summary || null,
    message.timestamp.getTime(),
    message.logFileName || null,
    message.requestId || null,
    message.messageType || 'normal',
    message.promptData ? JSON.stringify(message.promptData) : null,
    cliToolId,
    instanceId
  );

  // Update worktree's updated_at timestamp
  updateWorktreeTimestamp(db, message.worktreeId, message.timestamp);

  // If this is a user message, update last_user_message
  if (message.role === 'user') {
    updateLastUserMessage(db, message.worktreeId, message.content, message.timestamp);
  }

  return { id, ...message, archived: false };
}

/**
 * Update the content of an existing message
 */
interface MessageUpdateOptions {
  summary?: string;
  logFileName?: string;
  requestId?: string;
}

export function updateMessageContent(
  db: Database.Database,
  messageId: string,
  content: string,
  options?: MessageUpdateOptions
): void {
  const assignments: string[] = ['content = ?'];
  const params: (string | null)[] = [content];

  if (options?.summary !== undefined) {
    assignments.push('summary = ?');
    params.push(options.summary ?? null);
  }

  if (options?.logFileName !== undefined) {
    assignments.push('log_file_name = ?');
    params.push(options.logFileName ?? null);
  }

  if (options?.requestId !== undefined) {
    assignments.push('request_id = ?');
    params.push(options.requestId ?? null);
  }

  const stmt = db.prepare(`
    UPDATE chat_messages
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params, messageId);
}

/**
 * Get messages for a worktree, optionally filtered by CLI tool
 */
export function getMessages(
  db: Database.Database,
  worktreeId: string,
  options: GetMessagesOptions = {}
): ChatMessage[] {
  const { before, limit = 50, cliToolId, instanceId, includeArchived = false, messageType, limitUnit = 'messages' } = options;

  // Build the shared scope clause (worktree + before cursor + archived + instance/cli
  // filter) and its bound params. Used for both the message-unit and pair-unit paths
  // so their filtering stays identical.
  const buildScope = (): { clause: string; params: (string | number | null)[] } => {
    let clause = `FROM chat_messages
    WHERE worktree_id = ? AND (? IS NULL OR timestamp < ?)`;
    const params: (string | number | null)[] = [worktreeId, before?.getTime() || null, before?.getTime() || null];

    // archived filter (default: non-archived only)
    if (!includeArchived) {
      clause += ` ${ACTIVE_FILTER}`;
    }

    // Issue #868: instance filter takes precedence; otherwise fall back to CLI tool filter.
    if (instanceId) {
      clause += ` AND instance_id = ?`;
      params.push(instanceId);
    } else if (cliToolId) {
      clause += ` AND cli_tool_id = ?`;
      params.push(cliToolId);
    }

    // Issue #1685: message-type filter (prompt audit listing)
    if (messageType) {
      clause += ` AND message_type = ?`;
      params.push(messageType);
    }

    return { clause, params };
  };

  const SELECT_COLS = `SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived`;

  // Issue #1407: pair-unit paging. Resolve a timestamp cutoff so the newest `limit`
  // user turns are fully included (with all their assistant rows). This keeps the
  // rendered conversation-pair count equal to `limit` even when a single turn emits
  // many assistant rows (codex prompts/intermediate outputs). Falls back to
  // message-unit paging when no user messages exist in scope.
  if (limitUnit === 'pairs') {
    const scope = buildScope();
    const cutoffRow = db
      .prepare(
        `SELECT MIN(timestamp) AS cutoff FROM (
          SELECT timestamp ${scope.clause} AND role = 'user'
          ORDER BY timestamp DESC LIMIT ?
        )`
      )
      .get(...scope.params, limit) as { cutoff: number | null } | undefined;

    const cutoff = cutoffRow?.cutoff ?? null;
    if (cutoff !== null) {
      const full = buildScope();
      const rows = db
        .prepare(`${SELECT_COLS} ${full.clause} AND timestamp >= ? ORDER BY timestamp DESC`)
        .all(...full.params, cutoff) as ChatMessageRow[];
      return rows.map(mapChatMessage);
    }
    // No user messages in scope → fall through to message-unit behavior below.
  }

  const scope = buildScope();
  const rows = db
    .prepare(`${SELECT_COLS} ${scope.clause} ORDER BY timestamp DESC LIMIT ?`)
    .all(...scope.params, limit) as ChatMessageRow[];

  return rows.map(mapChatMessage);
}

/**
 * Fetch the most recent user-authored message for a worktree.
 */
export function getLastUserMessage(
  db: Database.Database,
  worktreeId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE worktree_id = ? AND role = 'user' ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/**
 * Fetch the message a producer wrote under this `request_id`, if any.
 *
 * Issue #2041: the idempotency probe for a history writer that can be asked to
 * save the same turn twice — once from the event stream and once from the
 * `GET /session/:id/message` backfill that runs on every reconnect. Both derive
 * the id from the agent's own message id, so "already there" is the whole test.
 *
 * `ACTIVE_FILTER` is deliberately **not** applied. An archived row is still a
 * row that was written, and skipping it here would make "kill the session"
 * (which archives) into "re-save every turn on the next attach", which is the
 * duplication this is for.
 *
 * Scoped by worktree because `request_id` is unique per producer, not globally:
 * two worktrees talking to the same `opencode.db` see the same session, and a
 * global lookup would let the first one to save a turn suppress it for the
 * second.
 *
 * @param requestId - The producer's own id for this row
 * @returns The row, or null when nothing has been written under it
 */
export function findMessageByRequestId(
  db: Database.Database,
  worktreeId: string,
  requestId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE worktree_id = ? AND request_id = ?
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId, requestId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/** Which rows {@link findUnkeyedUserMessages} will consider. */
export interface UnkeyedUserMessageQuery {
  readonly worktreeId: string;
  readonly cliToolId: CLIToolType;
  /** The agent instance; the primary instance's id equals `cliToolId`. */
  readonly instanceId: string;
  /** Oldest `timestamp` accepted, inclusive, as epoch ms. */
  readonly fromMs: number;
  /** Newest `timestamp` accepted, inclusive, as epoch ms. */
  readonly toMs: number;
  /** Cap on rows returned. Defaults to {@link UNKEYED_USER_MESSAGE_LIMIT}. */
  readonly limit?: number;
}

/**
 * How many candidate rows {@link findUnkeyedUserMessages} returns.
 *
 * The caller compares content in JavaScript, so this bounds the work rather than
 * the correctness. Twenty is far above the number of user rows one instance can
 * accumulate inside the caller's few-minute window and still small enough that
 * the query is never the expensive part of a poll.
 */
export const UNKEYED_USER_MESSAGE_LIMIT = 20;

/**
 * User rows for one instance that no producer has claimed yet (Issue #2196).
 *
 * The lookup behind "the operator's input is already in History — `/send` put it
 * there". A row qualifies when it is this instance's, is a `user` row, sits in
 * the caller's time window, and has **no `request_id`**: that last condition is
 * what makes the query safe to answer a *claim* with, because a row that already
 * carries a key belongs to whoever wrote it and must not be re-pointed at
 * another turn.
 *
 * Content is deliberately not compared here. "The same text" is a normalisation
 * question (trailing whitespace, `\r\n`, a composer that reflowed the body), and
 * SQL is the wrong place to decide it — see `normalizeUserTurnContent` in
 * `lib/history/user-turn-recorder`, which owns that rule and is the only thing
 * that has to change when the rule does.
 *
 * `COALESCE` on both tool columns is not defensive noise: rows written before
 * Issue #868 carry `instance_id IS NULL`, and `mapChatMessage` reads those as
 * the primary instance. A bare `instance_id = ?` would make those rows
 * invisible here while the UI still shows them, so the operator would see their
 * `/send` row *and* a second row this Issue inserted.
 *
 * `ACTIVE_FILTER` applies: an archived row has been cleared out of History, and
 * adopting one would key a turn to a row nobody can see.
 *
 * @returns Candidate rows, newest first
 */
export function findUnkeyedUserMessages(
  db: Database.Database,
  query: UnkeyedUserMessageQuery
): ChatMessage[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE worktree_id = ?
      AND role = 'user'
      AND request_id IS NULL
      AND COALESCE(cli_tool_id, 'claude') = ?
      AND COALESCE(instance_id, cli_tool_id, 'claude') = ?
      AND timestamp >= ? AND timestamp <= ?
      ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
    LIMIT ?
  `);

  const rows = stmt.all(
    query.worktreeId,
    query.cliToolId,
    query.instanceId,
    query.fromMs,
    query.toMs,
    query.limit ?? UNKEYED_USER_MESSAGE_LIMIT
  ) as ChatMessageRow[];

  return rows.map(mapChatMessage);
}

/**
 * Claim an unkeyed row for a producer, without touching anything else on it
 * (Issue #2196).
 *
 * A compare-and-set and not an `UPDATE … WHERE id = ?`: the `request_id IS NULL`
 * in the predicate is what makes two pollers racing on the same row safe, since
 * the loser changes nothing and is told so. {@link updateMessageContent} could
 * set the column too, but it also rewrites `content`, and rewriting the
 * operator's own words as a side effect of keying their row is exactly the
 * failure this Issue is trying not to introduce.
 *
 * @returns Whether this call is the one that claimed the row
 */
export function setMessageRequestId(
  db: Database.Database,
  messageId: string,
  requestId: string
): boolean {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET request_id = ?
    WHERE id = ? AND request_id IS NULL
  `);

  return stmt.run(requestId, messageId).changes > 0;
}

/**
 * Fetch the most recent message for a worktree (any role).
 * Used to determine if waiting for Claude's response.
 */
export function getLastMessage(
  db: Database.Database,
  worktreeId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE worktree_id = ? ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
    LIMIT 1
  `);

  const row = stmt.get(worktreeId) as ChatMessageRow | undefined;

  return row ? mapChatMessage(row) : null;
}

/**
 * Archive all active messages for a worktree (logical deletion)
 * Used when killing a session to clear message history while retaining for future viewing.
 * Note: Log files are preserved for historical reference
 *
 * Issue #168: Changed from physical DELETE to logical UPDATE (archived=1)
 * Function name maintained for backward compatibility (DR1-003)
 *
 * @returns Number of archived messages
 */
export function deleteAllMessages(
  db: Database.Database,
  worktreeId: string
): number {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET archived = 1
    WHERE worktree_id = ? ${ACTIVE_FILTER}
  `);

  const result = stmt.run(worktreeId);
  logger.info('archived-all-messages', { worktreeId, count: result.changes });
  return result.changes;
}

/**
 * Delete a single message by its ID
 * Used to clean up orphaned user messages (e.g., when a user re-sends a message
 * after the previous one received no response).
 *
 * @param db - Database instance
 * @param messageId - ID of the message to delete
 * @returns True if a message was deleted, false otherwise
 */
export function deleteMessageById(
  db: Database.Database,
  messageId: string
): boolean {
  const stmt = db.prepare(`
    DELETE FROM chat_messages
    WHERE id = ?
  `);

  const result = stmt.run(messageId);
  return result.changes > 0;
}

/**
 * Archive messages for a specific CLI tool in a worktree (logical deletion)
 * Issue #4: T4.2 - Individual CLI tool session termination (MF3-001)
 * Issue #168: Changed from physical DELETE to logical UPDATE (archived=1)
 *
 * Used when killing only a specific CLI tool's session to archive its message history
 * while preserving messages from other CLI tools.
 * Note: Log files are preserved for historical reference
 * Function name maintained for backward compatibility (DR1-003)
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param cliTool - CLI tool ID to archive messages for
 * @returns Number of archived messages
 */
export function deleteMessagesByCliTool(
  db: Database.Database,
  worktreeId: string,
  cliTool: CLIToolType
): number {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET archived = 1
    WHERE worktree_id = ? AND cli_tool_id = ? ${ACTIVE_FILTER}
  `);

  const result = stmt.run(worktreeId, cliTool);
  logger.info('archived-messages-by-cli-tool', { worktreeId, cliTool, count: result.changes });
  return result.changes;
}

/**
 * Archive messages for a specific agent instance in a worktree (logical deletion).
 * Issue #868: instance-scoped counterpart of deleteMessagesByCliTool, used when
 * killing a single agent instance while preserving other instances' history.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Agent instance ID to archive messages for
 * @returns Number of archived messages
 */
export function deleteMessagesByInstance(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): number {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET archived = 1
    WHERE worktree_id = ? AND instance_id = ? ${ACTIVE_FILTER}
  `);

  const result = stmt.run(worktreeId, instanceId);
  logger.info('archived-messages-by-instance', { worktreeId, instanceId, count: result.changes });
  return result.changes;
}

/**
 * Update worktree's last user message
 */
export function updateLastUserMessage(
  db: Database.Database,
  worktreeId: string,
  message: string,
  timestamp: Date
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_user_message = ?,
        last_user_message_at = ?
    WHERE id = ?
  `);

  // Truncate message to 200 characters
  const truncatedMessage = message.substring(0, 200);
  stmt.run(truncatedMessage, timestamp.getTime(), worktreeId);
}

/**
 * Clear worktree's last user message fields
 * Issue #168: Called after archiving messages to prevent stale data in sidebar
 */
export function clearLastUserMessage(
  db: Database.Database,
  worktreeId: string
): void {
  const stmt = db.prepare(`
    UPDATE worktrees
    SET last_user_message = NULL,
        last_user_message_at = NULL
    WHERE id = ?
  `);

  stmt.run(worktreeId);
}

/**
 * Recompute worktree's last_user_message from the remaining active (non-archived)
 * user messages (Issue #1171).
 *
 * A targeted (single-instance / single-CLI) kill archives only that scope's
 * messages, so other instances' un-archived user messages may still exist. In
 * that case the sidebar's last_user_message must reflect the newest *remaining*
 * message rather than being wiped — unconditionally clearing it (the pre-#1171
 * behavior) would drop metadata that belongs to a still-running instance.
 *
 * When no active user message remains (e.g. a kill-all, or the last message was
 * the archived one), this falls back to clearing the fields — matching the old
 * behavior for that case.
 */
export function recomputeLastUserMessage(
  db: Database.Database,
  worktreeId: string
): void {
  const latest = getLastUserMessage(db, worktreeId);
  if (latest) {
    updateLastUserMessage(db, worktreeId, latest.content, latest.timestamp);
  } else {
    clearLastUserMessage(db, worktreeId);
  }
}

/** Options for getMessagesByDateRange query */
export interface GetMessagesByDateRangeOptions {
  after: Date;
  before: Date;
  includeArchived?: boolean;
}

/**
 * Get messages across all worktrees within a date range.
 * Used for daily summary generation.
 *
 * Issue #607: Cross-worktree message retrieval for daily summary
 *
 * @param db - Database instance
 * @param options - Date range and filter options
 * @returns ChatMessage[] sorted by timestamp ASC
 */
export function getMessagesByDateRange(
  db: Database.Database,
  options: GetMessagesByDateRangeOptions
): ChatMessage[] {
  const { after, before, includeArchived = false } = options;

  let query = `
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE timestamp >= ? AND timestamp < ?
  `;

  if (!includeArchived) {
    query += ` ${ACTIVE_FILTER}`;
  }

  query += ` ORDER BY timestamp ASC`;

  const stmt = db.prepare(query);
  const rows = stmt.all(after.getTime(), before.getTime()) as ChatMessageRow[];

  return rows.map(mapChatMessage);
}

/**
 * Get message by ID
 */
export function getMessageById(
  db: Database.Database,
  messageId: string
): ChatMessage | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE id = ?
  `);

  const row = stmt.get(messageId) as ChatMessageRow | undefined;

  if (!row) {
    return null;
  }

  return mapChatMessage(row);
}

/**
 * Update prompt data for a message
 */
export function updatePromptData(
  db: Database.Database,
  messageId: string,
  promptData: Record<string, unknown>
): void {
  const stmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  stmt.run(JSON.stringify(promptData), messageId);
}

/**
 * Mark all pending prompts as answered for a worktree/CLI tool
 * This is called when we detect Claude has started processing (new response detected)
 * which means any pending prompts must have been answered via terminal
 *
 * @param onUpdated - Issue #2195. Invoked once per row that was actually
 *   stamped, with the row as it now reads. This sweep is the one prompt-status
 *   writer that produced no realtime frame, so a prompt card stayed "pending"
 *   in every open pane until the next history poll — up to 15s once #2195
 *   demoted that poll to a fallback. The caller supplies the broadcast rather
 *   than this module reaching for `ws-server`: the DB layer has no business
 *   importing the socket, and the two sweep callers that are *not* a poller
 *   (the worktree list/detail routes) have no room to broadcast into anyway.
 *   Throwing from the callback is the caller's problem; it is not caught here.
 */
export function markPendingPromptsAsAnswered(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
  onUpdated?: (message: ChatMessage) => void
): number {
  // Find all pending prompt messages for this worktree/CLI tool.
  // Issue #868: When instanceId is provided, scope to that instance only;
  // otherwise fall back to the legacy cli_tool_id scoping.
  const resolvedInstanceId = instanceId ?? cliToolId;
  // Issue #2195: the full column set, not just (id, prompt_data) — `onUpdated`
  // publishes a `ChatMessage`, and re-reading each row afterwards would be a
  // second query per prompt for data this statement already has to visit.
  const selectStmt = db.prepare(`
    SELECT id, worktree_id, role, content, summary, timestamp, log_file_name, request_id, message_type, prompt_data, cli_tool_id, instance_id, archived
    FROM chat_messages
    WHERE worktree_id = ?
      AND instance_id = ?
      AND message_type = 'prompt'
      AND json_extract(prompt_data, '$.status') = 'pending'
      ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
  `);

  const rows = selectStmt.all(worktreeId, resolvedInstanceId) as ChatMessageRow[];

  if (rows.length === 0) {
    return 0;
  }

  // Update each pending prompt to answered
  const updateStmt = db.prepare(`
    UPDATE chat_messages
    SET prompt_data = ?
    WHERE id = ?
  `);

  let updatedCount = 0;
  const updated: ChatMessage[] = [];
  for (const row of rows) {
    try {
      const promptData = JSON.parse(row.prompt_data ?? 'null');
      if (!promptData || typeof promptData !== 'object') continue;
      promptData.status = 'answered';
      promptData.answer = '(answered via terminal)';
      promptData.answeredAt = new Date().toISOString();
      // Issue #1685: attribution for the audit trail. This sweep only sees
      // prompts nothing else claimed, so all that is known is that the agent
      // moved on — i.e. someone acted in the terminal.
      promptData.answeredBy = 'terminal';
      const serialized = JSON.stringify(promptData);
      updateStmt.run(serialized, row.id);
      updatedCount++;
      if (onUpdated) {
        updated.push(mapChatMessage({ ...row, prompt_data: serialized }));
      }
    } catch {
      // Skip if prompt_data is invalid JSON
    }
  }

  // Published after every write lands, so a listener that reacts by reading the
  // table back cannot observe a half-swept instance.
  for (const message of updated) {
    onUpdated?.(message);
  }

  return updatedCount;
}

/** Parameters for {@link recordAnsweredPrompt} (Issue #1685). */
export interface RecordAnsweredPromptParams {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Agent instance that was asked. Defaults to the primary instance (=== cliToolId). */
  instanceId?: string;
  /** The prompt as detected on screen at answer time. */
  promptData: PromptData;
  /** The answer that was sent to the terminal. */
  answer: string;
  /** Who resolved the prompt. */
  answeredBy: PromptAnsweredBy;
  /** Content for a newly created row; defaults to the prompt's question. */
  content?: string;
}

/** Result of {@link recordAnsweredPrompt} (Issue #1685). */
export interface RecordAnsweredPromptResult {
  message: ChatMessage;
  /** True when no pending prompt row existed and a new (already-answered) row was created. */
  created: boolean;
}

/**
 * Persist "this prompt was just answered" to chat history (Issue #1685).
 *
 * The answer paths (Auto-Yes poller, /prompt-response) act on what is on
 * screen, not on a stored message, so the prompt they resolve may or may not
 * have been saved by the response poller yet:
 *
 * - If a pending prompt row exists for the instance, it is marked answered in
 *   place — preferring the row whose question matches the screen, falling back
 *   to the newest pending row (the two capture paths can clean text slightly
 *   differently).
 * - If none exists (the answer landed inside the response poller's interval —
 *   the exact case Issue #1685 is about), a new already-answered prompt row is
 *   created so the question/options/answer survive for the audit trail.
 */
export function recordAnsweredPrompt(
  db: Database.Database,
  params: RecordAnsweredPromptParams
): RecordAnsweredPromptResult {
  const { worktreeId, cliToolId, promptData, answer, answeredBy } = params;
  const resolvedInstanceId = params.instanceId ?? cliToolId;

  const rows = db
    .prepare(
      `
    SELECT id, prompt_data
    FROM chat_messages
    WHERE worktree_id = ?
      AND instance_id = ?
      AND message_type = 'prompt'
      AND json_extract(prompt_data, '$.status') = 'pending'
      ${ACTIVE_FILTER}
    ORDER BY timestamp DESC
  `
    )
    .all(worktreeId, resolvedInstanceId) as { id: string; prompt_data: string }[];

  let target: { id: string; parsed: Record<string, unknown> } | null = null;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.prompt_data) as Record<string, unknown>;
      if (!target) {
        target = { id: row.id, parsed };
      }
      if (parsed.question === promptData.question) {
        target = { id: row.id, parsed };
        break;
      }
    } catch {
      // Skip if prompt_data is invalid JSON
    }
  }

  const answeredAt = new Date().toISOString();

  if (target) {
    const updated = { ...target.parsed, status: 'answered', answer, answeredAt, answeredBy };
    updatePromptData(db, target.id, updated);
    return { message: getMessageById(db, target.id)!, created: false };
  }

  const message = createMessage(db, {
    worktreeId,
    role: 'assistant',
    content: params.content || promptData.question || '[prompt]',
    messageType: 'prompt',
    promptData: { ...promptData, status: 'answered', answer, answeredAt, answeredBy },
    timestamp: new Date(),
    cliToolId,
    instanceId: resolvedInstanceId,
  });
  return { message, created: true };
}
