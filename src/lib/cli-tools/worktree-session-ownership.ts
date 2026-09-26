/**
 * Session ownership by worktree id (Issue #2865).
 *
 * For callers that hold only a worktree id — the Auto-Yes poller — and would
 * otherwise have to reach into the DB and the tmux gateway separately. Kept out
 * of `session-ownership.ts` so the plain ownership check does not drag the DB
 * layer into every module that imports it.
 */

import { getDbInstance } from '../db/db-instance';
import { getWorktreeById } from '../db/worktree-db';
import { checkSessionOwnership, type SessionOwnership } from '../tmux/session-ownership';

/**
 * Ownership of `sessionName` against the worktree row `worktreeId`. `null` when
 * the row does not exist — the caller cannot vouch for the session and must not
 * drive it.
 */
export async function checkWorktreeSessionOwnership(
  worktreeId: string,
  sessionName: string
): Promise<SessionOwnership | null> {
  const worktree = getWorktreeById(getDbInstance(), worktreeId);
  if (!worktree) return null;
  return checkSessionOwnership(sessionName, worktree.path);
}
