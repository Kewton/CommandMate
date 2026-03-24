/**
 * Timer database operations
 * Issue #534: CRUD operations for timer_messages table
 *
 * [DP-002] Located in src/lib/db/ alongside other DB modules.
 * Follows same patterns as memo-db.ts, chat-db.ts, session-db.ts.
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { TimerStatus } from '@/config/timer-constants';

// =============================================================================
// Types
// =============================================================================

/** Timer message model (camelCase for API/client use) */
export interface TimerMessage {
  id: string;
  worktreeId: string;
  cliToolId: string;
  message: string;
  delayMs: number;
  scheduledSendTime: number;
  status: TimerStatus;
  createdAt: number;
  sentAt: number | null;
}

/** Parameters for creating a new timer */
export interface CreateTimerParams {
  worktreeId: string;
  cliToolId: string;
  message: string;
  delayMs: number;
}

// =============================================================================
// Internal Types
// =============================================================================

/** Database row type (snake_case) */
interface TimerMessageRow {
  id: string;
  worktree_id: string;
  cli_tool_id: string;
  message: string;
  delay_ms: number;
  scheduled_send_time: number;
  status: string;
  created_at: number;
  sent_at: number | null;
}

// =============================================================================
// Row Mapping
// =============================================================================

/** Map database row to TimerMessage model */
function mapRow(row: TimerMessageRow): TimerMessage {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id,
    message: row.message,
    delayMs: row.delay_ms,
    scheduledSendTime: row.scheduled_send_time,
    status: row.status as TimerStatus,
    createdAt: row.created_at,
    sentAt: row.sent_at,
  };
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a new timer entry.
 * Generates UUID, computes scheduledSendTime = now + delayMs.
 */
export function createTimer(
  db: Database.Database,
  params: CreateTimerParams
): TimerMessage {
  const id = randomUUID();
  const now = Date.now();
  const scheduledSendTime = now + params.delayMs;

  const stmt = db.prepare(`
    INSERT INTO timer_messages (id, worktree_id, cli_tool_id, message, delay_ms, scheduled_send_time, status, created_at, sent_at)
    VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
  `);

  stmt.run(
    id,
    params.worktreeId,
    params.cliToolId,
    params.message,
    params.delayMs,
    scheduledSendTime,
    now
  );

  return {
    id,
    worktreeId: params.worktreeId,
    cliToolId: params.cliToolId,
    message: params.message,
    delayMs: params.delayMs,
    scheduledSendTime,
    status: 'pending',
    createdAt: now,
    sentAt: null,
  };
}

/**
 * Get all timers for a worktree (all statuses), ordered by created_at DESC.
 */
export function getTimersByWorktree(
  db: Database.Database,
  worktreeId: string
): TimerMessage[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, cli_tool_id, message, delay_ms, scheduled_send_time, status, created_at, sent_at
    FROM timer_messages
    WHERE worktree_id = ?
    ORDER BY created_at DESC
  `);

  const rows = stmt.all(worktreeId) as TimerMessageRow[];
  return rows.map(mapRow);
}

/**
 * Get a single timer by ID.
 */
export function getTimerById(
  db: Database.Database,
  id: string
): TimerMessage | undefined {
  const stmt = db.prepare(`
    SELECT id, worktree_id, cli_tool_id, message, delay_ms, scheduled_send_time, status, created_at, sent_at
    FROM timer_messages
    WHERE id = ?
  `);

  const row = stmt.get(id) as TimerMessageRow | undefined;
  return row ? mapRow(row) : undefined;
}

/**
 * Get all pending timers (for server restart recovery).
 */
export function getPendingTimers(
  db: Database.Database
): TimerMessage[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, cli_tool_id, message, delay_ms, scheduled_send_time, status, created_at, sent_at
    FROM timer_messages
    WHERE status = 'pending'
    ORDER BY scheduled_send_time ASC
  `);

  const rows = stmt.all() as TimerMessageRow[];
  return rows.map(mapRow);
}

/**
 * Update timer status. Optionally set sentAt timestamp.
 */
export function updateTimerStatus(
  db: Database.Database,
  id: string,
  status: TimerStatus,
  sentAt?: number
): void {
  if (sentAt !== undefined) {
    db.prepare(`
      UPDATE timer_messages SET status = ?, sent_at = ? WHERE id = ?
    `).run(status, sentAt, id);
  } else {
    db.prepare(`
      UPDATE timer_messages SET status = ? WHERE id = ?
    `).run(status, id);
  }
}

/**
 * Cancel a pending timer (set status to 'cancelled').
 * Returns true if timer was cancelled, false if not found or not pending.
 */
export function cancelTimer(
  db: Database.Database,
  id: string
): boolean {
  const result = db.prepare(`
    UPDATE timer_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'
  `).run(id);

  return result.changes > 0;
}

/**
 * Cancel all pending timers for a worktree.
 * Returns the number of cancelled timers.
 */
export function cancelTimersByWorktree(
  db: Database.Database,
  worktreeId: string
): number {
  const result = db.prepare(`
    UPDATE timer_messages SET status = 'cancelled' WHERE worktree_id = ? AND status = 'pending'
  `).run(worktreeId);

  return result.changes;
}

/**
 * Get count of pending timers for a worktree (for MAX_TIMERS_PER_WORKTREE check).
 */
export function getPendingTimerCountByWorktree(
  db: Database.Database,
  worktreeId: string
): number {
  const result = db.prepare(`
    SELECT COUNT(*) as count FROM timer_messages WHERE worktree_id = ? AND status = 'pending'
  `).get(worktreeId) as { count: number };

  return result.count;
}
