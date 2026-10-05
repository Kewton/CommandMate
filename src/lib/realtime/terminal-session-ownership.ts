/**
 * "May this server write to, or show, the session under this name right now?"
 * (Issue #3334).
 *
 * Shared by the two realtime paths that address a session by a name they
 * resolved earlier: the WebSocket terminal (`ws-server.ts` — every
 * `terminal_input` / `terminal_resize` and the control-mode fallback capture)
 * and the terminal snapshot push (`terminal-broadcast.ts`). Both outlive the
 * moment they were set up — a socket, a poller chain — and a session that
 * ended and was started again by another CommandMate server under the same
 * name (#2865) would otherwise receive this server's keys, or have its screen
 * pushed to this server's tabs. So both ask again before every write or read,
 * the way the routes ask per request.
 *
 * Kept out of `ws-server.ts` so the push can import it without loading the
 * socket server (and so the many suites that stub `@/lib/ws-server` keep
 * stubbing only what they meant to).
 *
 * @module lib/realtime/terminal-session-ownership
 */

import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { checkSessionOwnership } from '@/lib/cli-tools/session-ownership';

/** The `terminal_error` text for a session another CommandMate server owns. */
export const FOREIGN_TERMINAL_SESSION_ERROR = 'Session belongs to another CommandMate server';

/**
 * Why the session may not be touched now, or null.
 *
 * The worktree row is re-read by id because a rename re-points a terminal
 * subscription (`migrateWorktreeRooms`); a row that is gone cannot vouch for
 * the session, which is refused for the same reason `sendUserMessage` refuses
 * it. An absent session is not refused here — there is nothing of anyone's to
 * show or type into, and each caller already handles a missing session.
 */
export async function findTerminalSessionRefusal(
  worktreeId: string,
  sessionName: string
): Promise<string | null> {
  const worktree = getWorktreeById(getDbInstance(), worktreeId);
  if (!worktree) return 'Worktree not found';
  const ownership = await checkSessionOwnership(sessionName, worktree.path);
  return ownership.verdict === 'foreign' ? FOREIGN_TERMINAL_SESSION_ERROR : null;
}
