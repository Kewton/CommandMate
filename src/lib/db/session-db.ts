/**
 * Session state database operations
 * CRUD operations for session_states table
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import Database from 'better-sqlite3';
import type { WorktreeSessionState } from '@/types/models';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Get session state for a worktree.
 *
 * Issue #868: session_states is keyed by (worktree_id, instance_id). The third
 * argument identifies the instance; for the primary instance instanceId equals
 * cliToolId, so existing call sites that pass only the CLI tool ID keep working.
 *
 * @param db - Database instance
 * @param worktreeId - Worktree ID
 * @param instanceId - Agent instance ID (defaults to 'claude', the primary Claude instance)
 */
export function getSessionState(
  db: Database.Database,
  worktreeId: string,
  instanceId: string = 'claude'
): WorktreeSessionState | null {
  const stmt = db.prepare(`
    SELECT worktree_id, cli_tool_id, instance_id, last_captured_line, in_progress_message_id
    FROM session_states
    WHERE worktree_id = ? AND instance_id = ?
  `);

  const row = stmt.get(worktreeId, instanceId) as {
    worktree_id: string;
    cli_tool_id: string;
    instance_id: string;
    last_captured_line: number;
    in_progress_message_id: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id as CLIToolType,
    instanceId: row.instance_id,
    lastCapturedLine: row.last_captured_line,
    inProgressMessageId: row.in_progress_message_id || null,
  };
}

/**
 * Update session state for a worktree.
 *
 * Issue #868: Keyed by (worktree_id, instance_id). The cli_tool_id column is
 * still persisted so the owning tool is recoverable. When instanceId is omitted
 * it defaults to cliToolId (primary instance), preserving legacy behavior.
 */
export function updateSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  lastCapturedLine: number,
  instanceId?: string
): void {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, instance_id, last_captured_line)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line,
      cli_tool_id = excluded.cli_tool_id
  `);

  stmt.run(worktreeId, cliToolId, resolvedInstanceId, lastCapturedLine);
}

/**
 * Set the in-progress message ID for a session
 *
 * Issue #868: Keyed by (worktree_id, instance_id); instanceId defaults to cliToolId.
 */
export function setInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  messageId: string | null,
  instanceId?: string
): void {
  const resolvedInstanceId = instanceId ?? cliToolId;
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, instance_id, last_captured_line, in_progress_message_id)
    VALUES (?, ?, ?, 0, ?)
    ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
      in_progress_message_id = excluded.in_progress_message_id,
      cli_tool_id = excluded.cli_tool_id
  `);

  stmt.run(worktreeId, cliToolId, resolvedInstanceId, messageId);
}

/**
 * Clear the in-progress message ID for a session
 *
 * Issue #868: instanceId defaults to cliToolId (primary instance).
 */
export function clearInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  setInProgressMessageId(db, worktreeId, cliToolId, null, instanceId);
}

/**
 * Delete session state for a worktree
 * Called when a session is killed or reset.
 *
 * Issue #868: When instanceId is provided, only that instance's row is deleted.
 * Otherwise, when cliToolId is provided, all rows for that CLI tool are deleted
 * (legacy behavior). With neither, all rows for the worktree are deleted.
 */
export function deleteSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId?: CLIToolType,
  instanceId?: string
): void {
  if (instanceId) {
    const stmt = db.prepare(`
      DELETE FROM session_states
      WHERE worktree_id = ? AND instance_id = ?
    `);
    stmt.run(worktreeId, instanceId);
  } else if (cliToolId) {
    const stmt = db.prepare(`
      DELETE FROM session_states
      WHERE worktree_id = ? AND cli_tool_id = ?
    `);
    stmt.run(worktreeId, cliToolId);
  } else {
    const stmt = db.prepare(`
      DELETE FROM session_states
      WHERE worktree_id = ?
    `);
    stmt.run(worktreeId);
  }
}
