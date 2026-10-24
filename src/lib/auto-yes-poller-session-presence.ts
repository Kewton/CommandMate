/**
 * Auto-Yes poller: whether the session a failed capture was for is gone
 * (Issue #3329) (Issue #3893: split out of `auto-yes-poller.ts`).
 *
 * Does not import `auto-yes-poller.ts` (no cycle).
 *
 * @module lib/auto-yes-poller-session-presence
 */

import type { CLIToolType } from './cli-tools/types';
import { getSessionPresence } from './session/cli-session';

/**
 * Whether a failed capture failed because the session does not exist
 * (Issue #3329). Asked of tmux (`has-session`'s exit code), not read off the
 * error text. `unknown` — tmux timed out or could not be run — is not "absent":
 * the failure is counted as before, so a broken tmux still stops Auto-Yes.
 */
export async function isSessionMissing(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string,
): Promise<boolean> {
  try {
    return (await getSessionPresence(worktreeId, cliToolId, instanceId)) === 'absent';
  } catch {
    return false;
  }
}
