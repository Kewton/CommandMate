/**
 * Session ownership by worktree id (Issue #2865).
 *
 * For callers that hold only a worktree id — the Auto-Yes poller and
 * `sendUserMessage` (timer / relay sends) — and would
 * otherwise have to reach into the DB and the tmux gateway separately. Kept out
 * of `session-ownership.ts` so the plain ownership check does not drag the DB
 * layer into every module that imports it.
 */

import type Database from 'better-sqlite3';
import { getDbInstance } from '../db/db-instance';
import { getWorktreeById } from '../db/worktree-db';
import { checkSessionOwnership, type SessionOwnership } from '../tmux/session-ownership';

/**
 * Ownership of `sessionName` against the worktree row `worktreeId`. `null` when
 * the row does not exist — the caller cannot vouch for the session and must not
 * drive it.
 *
 * @param db - The handle to read the row from; defaults to the server's
 */
export async function checkWorktreeSessionOwnership(
  worktreeId: string,
  sessionName: string,
  db: Database.Database = getDbInstance()
): Promise<SessionOwnership | null> {
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return null;
  return checkSessionOwnership(sessionName, worktree.path);
}
