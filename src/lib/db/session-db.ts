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
 * Get session state for a worktree
 */
export function getSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType = 'claude'
): WorktreeSessionState | null {
  const stmt = db.prepare(`
    SELECT worktree_id, cli_tool_id, last_captured_line, in_progress_message_id
    FROM session_states
    WHERE worktree_id = ? AND cli_tool_id = ?
  `);

  const row = stmt.get(worktreeId, cliToolId) as {
    worktree_id: string;
    cli_tool_id: string;
    last_captured_line: number;
    in_progress_message_id: string | null;
  } | undefined;

  if (!row) {
    return null;
  }

  return {
    worktreeId: row.worktree_id,
    cliToolId: row.cli_tool_id as CLIToolType,
    lastCapturedLine: row.last_captured_line,
    inProgressMessageId: row.in_progress_message_id || null,
  };
}

/**
 * Update session state for a worktree
 */
export function updateSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  lastCapturedLine: number
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line)
    VALUES (?, ?, ?)
    ON CONFLICT(worktree_id, cli_tool_id) DO UPDATE SET
      last_captured_line = excluded.last_captured_line
  `);

  stmt.run(worktreeId, cliToolId, lastCapturedLine);
}

/**
 * Set the in-progress message ID for a session
 */
export function setInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  messageId: string | null
): void {
  const stmt = db.prepare(`
    INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line, in_progress_message_id)
    VALUES (?, ?, 0, ?)
    ON CONFLICT(worktree_id, cli_tool_id) DO UPDATE SET
      in_progress_message_id = excluded.in_progress_message_id
  `);

  stmt.run(worktreeId, cliToolId, messageId);
}

/**
 * Clear the in-progress message ID for a session
 */
export function clearInProgressMessageId(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType
): void {
  setInProgressMessageId(db, worktreeId, cliToolId, null);
}

/**
 * Delete session state for a worktree
 * Called when a session is killed or reset
 */
export function deleteSessionState(
  db: Database.Database,
  worktreeId: string,
  cliToolId?: CLIToolType
): void {
  if (cliToolId) {
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
