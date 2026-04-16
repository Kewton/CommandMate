/**
 * Assistant conversation database operations.
 * Home Assistant Chat uses its own conversation/message/state tables.
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';

export type AssistantConversationStatus = 'ready' | 'running' | 'stopped';
export type AssistantConversationExecutionMode = 'interactive' | 'non_interactive';
export type AssistantMessageRole = 'user' | 'assistant' | 'system';
export type AssistantMessageType = 'normal' | 'session_boundary';
export type AssistantMessageDeliveryStatus = 'pending' | 'sent' | 'failed';
export type AssistantExecutionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const MAX_ASSISTANT_PROMPT_BYTES = 64 * 1024;
export const MAX_ASSISTANT_LOG_BYTES = 256 * 1024;
export const MAX_ASSISTANT_FINAL_MESSAGE_BYTES = 64 * 1024;

export interface AssistantConversation {
  id: string;
  repositoryId: string;
  cliToolId: CLIToolType;
  workingDirectory: string;
  executionMode: AssistantConversationExecutionMode;
  resumeSessionId?: string;
  lastExecutionId?: string;
  sessionName?: string;
  status: AssistantConversationStatus;
  lastStartedAt?: Date;
  lastStoppedAt?: Date;
  contextSentAt?: Date;
  contextSnapshot?: string;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

export interface AssistantMessage {
  id: string;
  conversationId: string;
  role: AssistantMessageRole;
  content: string;
  summary?: string;
  timestamp: Date;
  messageType: AssistantMessageType;
  deliveryStatus?: AssistantMessageDeliveryStatus;
  archived: boolean;
}

export interface AssistantSessionState {
  conversationId: string;
  lastCapturedLine: number;
  inProgressMessageId: string | null;
}

export interface AssistantExecution {
  id: string;
  conversationId: string;
  cliToolId: CLIToolType;
  status: AssistantExecutionStatus;
  pid?: number;
  commandLine: string;
  promptText: string;
  stdoutText?: string;
  stderrText?: string;
  finalMessageText?: string;
  exitCode?: number | null;
  resumeSessionIdBefore?: string;
  resumeSessionIdAfter?: string;
  startedAt?: Date;
  finishedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

interface AssistantConversationRow {
  id: string;
  repository_id: string;
  cli_tool_id: string;
  working_directory: string;
  execution_mode?: string | null;
  resume_session_id?: string | null;
  last_execution_id?: string | null;
  session_name: string | null;
  status: string;
  last_started_at: number | null;
  last_stopped_at: number | null;
  context_sent_at: number | null;
  context_snapshot?: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
}

interface AssistantMessageRow {
  id: string;
  conversation_id: string;
  role: AssistantMessageRole;
  content: string;
  summary: string | null;
  timestamp: number;
  message_type: AssistantMessageType;
  delivery_status: AssistantMessageDeliveryStatus | null;
  archived: number;
}

interface AssistantExecutionRow {
  id: string;
  conversation_id: string;
  cli_tool_id: string;
  status: AssistantExecutionStatus;
  pid: number | null;
  command_line: string;
  prompt_text: string;
  stdout_text: string | null;
  stderr_text: string | null;
  final_message_text: string | null;
  exit_code: number | null;
  resume_session_id_before: string | null;
  resume_session_id_after: string | null;
  started_at: number | null;
  finished_at: number | null;
  created_at: number;
  updated_at: number;
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf-8') <= maxBytes) {
    return value;
  }

  const truncated = Buffer.from(value, 'utf-8').subarray(0, maxBytes).toString('utf-8');
  return truncated;
}

function mapConversationRow(row: AssistantConversationRow): AssistantConversation {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    cliToolId: row.cli_tool_id as CLIToolType,
    workingDirectory: row.working_directory,
    executionMode: (row.execution_mode ?? 'interactive') as AssistantConversationExecutionMode,
    resumeSessionId: row.resume_session_id ?? undefined,
    lastExecutionId: row.last_execution_id ?? undefined,
    sessionName: row.session_name ?? undefined,
    status: (row.status === 'idle' ? 'stopped' : row.status) as AssistantConversationStatus,
    lastStartedAt: row.last_started_at ? new Date(row.last_started_at) : undefined,
    lastStoppedAt: row.last_stopped_at ? new Date(row.last_stopped_at) : undefined,
    contextSentAt: row.context_sent_at ? new Date(row.context_sent_at) : undefined,
    contextSnapshot: row.context_snapshot ?? undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
    archived: row.archived === 1,
  };
}

function mapMessageRow(row: AssistantMessageRow): AssistantMessage {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    role: row.role,
    content: row.content,
    summary: row.summary ?? undefined,
    timestamp: new Date(row.timestamp),
    messageType: row.message_type,
    deliveryStatus: row.delivery_status ?? undefined,
    archived: row.archived === 1,
  };
}

function mapExecutionRow(row: AssistantExecutionRow): AssistantExecution {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    cliToolId: row.cli_tool_id as CLIToolType,
    status: row.status,
    pid: row.pid ?? undefined,
    commandLine: row.command_line,
    promptText: row.prompt_text,
    stdoutText: row.stdout_text ?? undefined,
    stderrText: row.stderr_text ?? undefined,
    finalMessageText: row.final_message_text ?? undefined,
    exitCode: row.exit_code,
    resumeSessionIdBefore: row.resume_session_id_before ?? undefined,
    resumeSessionIdAfter: row.resume_session_id_after ?? undefined,
    startedAt: row.started_at ? new Date(row.started_at) : undefined,
    finishedAt: row.finished_at ? new Date(row.finished_at) : undefined,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

function touchConversation(
  db: Database.Database,
  conversationId: string,
  timestamp: Date
): void {
  db.prepare(`
    UPDATE assistant_conversations
    SET updated_at = ?
    WHERE id = ?
  `).run(timestamp.getTime(), conversationId);
}

export function getAssistantConversationById(
  db: Database.Database,
  conversationId: string,
  options: { includeArchived?: boolean } = {}
): AssistantConversation | null {
  const query = `
    SELECT *
    FROM assistant_conversations
    WHERE id = ?
      ${options.includeArchived ? '' : 'AND archived = 0'}
    LIMIT 1
  `;

  const row = db.prepare(query).get(conversationId) as AssistantConversationRow | undefined;
  return row ? mapConversationRow(row) : null;
}

export function getAssistantConversationByRepositoryAndCliTool(
  db: Database.Database,
  repositoryId: string,
  cliToolId: CLIToolType,
  options: { includeArchived?: boolean } = {}
): AssistantConversation | null {
  const query = `
    SELECT *
    FROM assistant_conversations
    WHERE repository_id = ?
      AND cli_tool_id = ?
      ${options.includeArchived ? '' : 'AND archived = 0'}
    LIMIT 1
  `;

  const row = db.prepare(query).get(repositoryId, cliToolId) as AssistantConversationRow | undefined;
  return row ? mapConversationRow(row) : null;
}

export function createAssistantConversation(
  db: Database.Database,
  input: {
    repositoryId: string;
    cliToolId: CLIToolType;
    workingDirectory: string;
    executionMode?: AssistantConversationExecutionMode;
    resumeSessionId?: string;
    lastExecutionId?: string;
    sessionName?: string;
    status?: AssistantConversationStatus;
    contextSentAt?: Date;
    lastStartedAt?: Date;
    lastStoppedAt?: Date;
  }
): AssistantConversation {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO assistant_conversations (
      id, repository_id, cli_tool_id, working_directory, execution_mode, resume_session_id,
      last_execution_id, session_name, status,
      last_started_at, last_stopped_at, context_sent_at, created_at, updated_at, archived
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    input.repositoryId,
    input.cliToolId,
    input.workingDirectory,
    input.executionMode ?? 'interactive',
    input.resumeSessionId ?? null,
    input.lastExecutionId ?? null,
    input.sessionName ?? null,
    input.status ?? 'stopped',
    input.lastStartedAt?.getTime() ?? null,
    input.lastStoppedAt?.getTime() ?? null,
    input.contextSentAt?.getTime() ?? null,
    now,
    now
  );

  return {
    id,
    repositoryId: input.repositoryId,
    cliToolId: input.cliToolId,
    workingDirectory: input.workingDirectory,
    executionMode: input.executionMode ?? 'interactive',
    resumeSessionId: input.resumeSessionId,
    lastExecutionId: input.lastExecutionId,
    sessionName: input.sessionName,
    status: input.status ?? 'stopped',
    contextSentAt: input.contextSentAt,
    lastStartedAt: input.lastStartedAt,
    lastStoppedAt: input.lastStoppedAt,
    createdAt: new Date(now),
    updatedAt: new Date(now),
    archived: false,
  };
}

interface UpdateAssistantConversationInput {
  workingDirectory?: string;
  executionMode?: AssistantConversationExecutionMode;
  resumeSessionId?: string | null;
  lastExecutionId?: string | null;
  sessionName?: string | null;
  status?: AssistantConversationStatus;
  lastStartedAt?: Date | null;
  lastStoppedAt?: Date | null;
  contextSentAt?: Date | null;
  contextSnapshot?: string | null;
  archived?: boolean;
  updatedAt?: Date;
}

export function updateAssistantConversation(
  db: Database.Database,
  conversationId: string,
  updates: UpdateAssistantConversationInput
): AssistantConversation | null {
  const assignments: string[] = [];
  const params: Array<string | number | null> = [];

  if (updates.workingDirectory !== undefined) {
    assignments.push('working_directory = ?');
    params.push(updates.workingDirectory);
  }

  if (updates.executionMode !== undefined) {
    assignments.push('execution_mode = ?');
    params.push(updates.executionMode);
  }

  if (updates.resumeSessionId !== undefined) {
    assignments.push('resume_session_id = ?');
    params.push(updates.resumeSessionId);
  }

  if (updates.lastExecutionId !== undefined) {
    assignments.push('last_execution_id = ?');
    params.push(updates.lastExecutionId);
  }

  if (updates.sessionName !== undefined) {
    assignments.push('session_name = ?');
    params.push(updates.sessionName);
  }

  if (updates.status !== undefined) {
    assignments.push('status = ?');
    params.push(updates.status);
  }

  if (updates.lastStartedAt !== undefined) {
    assignments.push('last_started_at = ?');
    params.push(updates.lastStartedAt?.getTime() ?? null);
  }

  if (updates.lastStoppedAt !== undefined) {
    assignments.push('last_stopped_at = ?');
    params.push(updates.lastStoppedAt?.getTime() ?? null);
  }

  if (updates.contextSentAt !== undefined) {
    assignments.push('context_sent_at = ?');
    params.push(updates.contextSentAt?.getTime() ?? null);
  }

  if (updates.contextSnapshot !== undefined) {
    assignments.push('context_snapshot = ?');
    params.push(updates.contextSnapshot ?? null);
  }

  if (updates.archived !== undefined) {
    assignments.push('archived = ?');
    params.push(updates.archived ? 1 : 0);
  }

  const updatedAt = updates.updatedAt ?? new Date();
  assignments.push('updated_at = ?');
  params.push(updatedAt.getTime());
  params.push(conversationId);

  db.prepare(`
    UPDATE assistant_conversations
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getAssistantConversationById(db, conversationId, { includeArchived: true });
}

export function createAssistantMessage(
  db: Database.Database,
  message: Omit<AssistantMessage, 'id' | 'archived'>
): AssistantMessage {
  const id = randomUUID();

  db.prepare(`
    INSERT INTO assistant_messages (
      id, conversation_id, role, content, summary, timestamp, message_type, delivery_status, archived
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)
  `).run(
    id,
    message.conversationId,
    message.role,
    message.content,
    message.summary ?? null,
    message.timestamp.getTime(),
    message.messageType,
    message.deliveryStatus ?? null
  );

  touchConversation(db, message.conversationId, message.timestamp);

  return {
    id,
    ...message,
    archived: false,
  };
}

export function updateAssistantMessageStatus(
  db: Database.Database,
  messageId: string,
  deliveryStatus: AssistantMessageDeliveryStatus
): void {
  db.prepare(`
    UPDATE assistant_messages
    SET delivery_status = ?
    WHERE id = ?
  `).run(deliveryStatus, messageId);
}

export function getAssistantMessages(
  db: Database.Database,
  conversationId: string,
  options: { limit?: number; before?: Date; includeArchived?: boolean } = {}
): AssistantMessage[] {
  const { limit = 200, before, includeArchived = false } = options;

  const params: Array<string | number | null> = [conversationId, before?.getTime() ?? null, before?.getTime() ?? null];
  let query = `
    SELECT *
    FROM assistant_messages
    WHERE conversation_id = ?
      AND (? IS NULL OR timestamp < ?)
  `;

  if (!includeArchived) {
    query += ' AND archived = 0';
  }

  query += ' ORDER BY timestamp DESC LIMIT ?';
  params.push(limit);

  const rows = db.prepare(query).all(...params) as AssistantMessageRow[];
  return rows.map(mapMessageRow);
}

export function archiveAllAssistantMessages(
  db: Database.Database,
  conversationId: string
): number {
  const result = db.prepare(`
    UPDATE assistant_messages
    SET archived = 1
    WHERE conversation_id = ?
      AND archived = 0
  `).run(conversationId);

  return result.changes;
}

export function archiveAssistantMessagesFrom(
  db: Database.Database,
  conversationId: string,
  fromTimestampMs: number
): number {
  const result = db.prepare(`
    UPDATE assistant_messages
    SET archived = 1
    WHERE conversation_id = ?
      AND archived = 0
      AND timestamp >= ?
  `).run(conversationId, fromTimestampMs);

  return result.changes;
}

export function getAssistantMessageById(
  db: Database.Database,
  messageId: string
): AssistantMessage | null {
  const row = db.prepare(`
    SELECT * FROM assistant_messages WHERE id = ?
  `).get(messageId) as AssistantMessageRow | undefined;

  return row ? mapMessageRow(row) : null;
}

export function createAssistantExecution(
  db: Database.Database,
  input: {
    conversationId: string;
    cliToolId: CLIToolType;
    status?: AssistantExecutionStatus;
    pid?: number;
    commandLine: string;
    promptText: string;
    stdoutText?: string;
    stderrText?: string;
    finalMessageText?: string;
    exitCode?: number | null;
    resumeSessionIdBefore?: string;
    resumeSessionIdAfter?: string;
    startedAt?: Date;
    finishedAt?: Date;
  }
): AssistantExecution {
  const id = randomUUID();
  const now = Date.now();

  db.prepare(`
    INSERT INTO assistant_executions (
      id, conversation_id, cli_tool_id, status, pid, command_line, prompt_text,
      stdout_text, stderr_text, final_message_text, exit_code, resume_session_id_before,
      resume_session_id_after, started_at, finished_at, created_at, updated_at
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    input.conversationId,
    input.cliToolId,
    input.status ?? 'queued',
    input.pid ?? null,
    input.commandLine,
    truncateUtf8(input.promptText, MAX_ASSISTANT_PROMPT_BYTES),
    truncateUtf8(input.stdoutText ?? '', MAX_ASSISTANT_LOG_BYTES) || null,
    truncateUtf8(input.stderrText ?? '', MAX_ASSISTANT_LOG_BYTES) || null,
    input.finalMessageText
      ? truncateUtf8(input.finalMessageText, MAX_ASSISTANT_FINAL_MESSAGE_BYTES)
      : null,
    input.exitCode ?? null,
    input.resumeSessionIdBefore ?? null,
    input.resumeSessionIdAfter ?? null,
    input.startedAt?.getTime() ?? null,
    input.finishedAt?.getTime() ?? null,
    now,
    now,
  );

  touchConversation(db, input.conversationId, new Date(now));

  return {
    id,
    conversationId: input.conversationId,
    cliToolId: input.cliToolId,
    status: input.status ?? 'queued',
    pid: input.pid,
    commandLine: input.commandLine,
    promptText: truncateUtf8(input.promptText, MAX_ASSISTANT_PROMPT_BYTES),
    stdoutText: input.stdoutText ? truncateUtf8(input.stdoutText, MAX_ASSISTANT_LOG_BYTES) : undefined,
    stderrText: input.stderrText ? truncateUtf8(input.stderrText, MAX_ASSISTANT_LOG_BYTES) : undefined,
    finalMessageText: input.finalMessageText
      ? truncateUtf8(input.finalMessageText, MAX_ASSISTANT_FINAL_MESSAGE_BYTES)
      : undefined,
    exitCode: input.exitCode,
    resumeSessionIdBefore: input.resumeSessionIdBefore,
    resumeSessionIdAfter: input.resumeSessionIdAfter,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

interface UpdateAssistantExecutionInput {
  status?: AssistantExecutionStatus;
  pid?: number | null;
  stdoutText?: string | null;
  stderrText?: string | null;
  finalMessageText?: string | null;
  exitCode?: number | null;
  resumeSessionIdAfter?: string | null;
  startedAt?: Date | null;
  finishedAt?: Date | null;
  updatedAt?: Date;
}

export function updateAssistantExecution(
  db: Database.Database,
  executionId: string,
  updates: UpdateAssistantExecutionInput,
): AssistantExecution | null {
  const assignments: string[] = [];
  const params: Array<string | number | null> = [];

  if (updates.status !== undefined) {
    assignments.push('status = ?');
    params.push(updates.status);
  }

  if (updates.pid !== undefined) {
    assignments.push('pid = ?');
    params.push(updates.pid);
  }

  if (updates.stdoutText !== undefined) {
    assignments.push('stdout_text = ?');
    params.push(updates.stdoutText ? truncateUtf8(updates.stdoutText, MAX_ASSISTANT_LOG_BYTES) : null);
  }

  if (updates.stderrText !== undefined) {
    assignments.push('stderr_text = ?');
    params.push(updates.stderrText ? truncateUtf8(updates.stderrText, MAX_ASSISTANT_LOG_BYTES) : null);
  }

  if (updates.finalMessageText !== undefined) {
    assignments.push('final_message_text = ?');
    params.push(
      updates.finalMessageText
        ? truncateUtf8(updates.finalMessageText, MAX_ASSISTANT_FINAL_MESSAGE_BYTES)
        : null,
    );
  }

  if (updates.exitCode !== undefined) {
    assignments.push('exit_code = ?');
    params.push(updates.exitCode);
  }

  if (updates.resumeSessionIdAfter !== undefined) {
    assignments.push('resume_session_id_after = ?');
    params.push(updates.resumeSessionIdAfter);
  }

  if (updates.startedAt !== undefined) {
    assignments.push('started_at = ?');
    params.push(updates.startedAt?.getTime() ?? null);
  }

  if (updates.finishedAt !== undefined) {
    assignments.push('finished_at = ?');
    params.push(updates.finishedAt?.getTime() ?? null);
  }

  const updatedAt = updates.updatedAt ?? new Date();
  assignments.push('updated_at = ?');
  params.push(updatedAt.getTime(), executionId);

  db.prepare(`
    UPDATE assistant_executions
    SET ${assignments.join(', ')}
    WHERE id = ?
  `).run(...params);

  return getAssistantExecutionById(db, executionId);
}

export function getAssistantExecutionById(
  db: Database.Database,
  executionId: string,
): AssistantExecution | null {
  const row = db.prepare(`
    SELECT *
    FROM assistant_executions
    WHERE id = ?
    LIMIT 1
  `).get(executionId) as AssistantExecutionRow | undefined;

  return row ? mapExecutionRow(row) : null;
}

export function getLatestAssistantExecutionByConversation(
  db: Database.Database,
  conversationId: string,
): AssistantExecution | null {
  const row = db.prepare(`
    SELECT *
    FROM assistant_executions
    WHERE conversation_id = ?
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId) as AssistantExecutionRow | undefined;

  return row ? mapExecutionRow(row) : null;
}

export function getRunningAssistantExecutionByConversation(
  db: Database.Database,
  conversationId: string,
): AssistantExecution | null {
  const row = db.prepare(`
    SELECT *
    FROM assistant_executions
    WHERE conversation_id = ?
      AND status = 'running'
    ORDER BY created_at DESC
    LIMIT 1
  `).get(conversationId) as AssistantExecutionRow | undefined;

  return row ? mapExecutionRow(row) : null;
}

export function listRunningAssistantExecutions(
  db: Database.Database,
): AssistantExecution[] {
  const rows = db.prepare(`
    SELECT *
    FROM assistant_executions
    WHERE status = 'running'
    ORDER BY created_at DESC
  `).all() as AssistantExecutionRow[];

  return rows.map(mapExecutionRow);
}

export function getAssistantSessionState(
  db: Database.Database,
  conversationId: string
): AssistantSessionState | null {
  const row = db.prepare(`
    SELECT conversation_id, last_captured_line, in_progress_message_id
    FROM assistant_session_states
    WHERE conversation_id = ?
  `).get(conversationId) as {
    conversation_id: string;
    last_captured_line: number;
    in_progress_message_id: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    conversationId: row.conversation_id,
    lastCapturedLine: row.last_captured_line,
    inProgressMessageId: row.in_progress_message_id,
  };
}

export function updateAssistantSessionState(
  db: Database.Database,
  conversationId: string,
  lastCapturedLine: number,
  inProgressMessageId?: string | null
): void {
  db.prepare(`
    INSERT INTO assistant_session_states (conversation_id, last_captured_line, in_progress_message_id)
    VALUES (?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line,
      in_progress_message_id = excluded.in_progress_message_id
  `).run(conversationId, lastCapturedLine, inProgressMessageId ?? null);
}

export function deleteAssistantSessionState(
  db: Database.Database,
  conversationId: string
): void {
  db.prepare(`
    DELETE FROM assistant_session_states
    WHERE conversation_id = ?
  `).run(conversationId);
}
