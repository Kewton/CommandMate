/**
 * Direct input gateway (Issue #2765).
 *
 * `POST /api/worktrees/[id]/direct-input` must not import `@/lib/tmux/**`
 * (§4 D4, `tests/unit/guards/tmux-import-allowlist.test.ts`), and it must not
 * grow `ICLITool` either — every hand-written `ICLITool` in the test suite would
 * stop type-checking. So the route calls this one function, which lives inside
 * the CLITool gateway and is therefore allowed to reach the transport.
 *
 * Issue #3290: this function finds the session by NAME and sends. Whether the
 * session is this server's is not decided here — it takes no worktree path to
 * compare `#{session_path}` with — so the caller has to have asked
 * `checkSessionOwnership` first, as the route does. A caller that skips it types
 * into whichever server owns the name;
 * `tests/unit/guards/worktree-route-session-ownership-3290.test.ts` fails a
 * worktree route that does.
 */

import { CLIToolManager } from './manager';
import type { CLIToolType } from './types';
import { hasSession, sendDirectInputAndInvalidate } from '../tmux/tmux';
import type { DirectInputEvent } from '@/types/direct-input';

export type DirectInputResult = 'sent' | 'session-not-found';

export async function sendDirectInput(
  cliToolId: CLIToolType,
  worktreeId: string,
  events: readonly DirectInputEvent[],
  instanceId?: string
): Promise<DirectInputResult> {
  const cliTool = CLIToolManager.getInstance().getTool(cliToolId);
  const sessionName = cliTool.getSessionName(worktreeId, instanceId);
  if (!(await hasSession(sessionName))) return 'session-not-found';
  await sendDirectInputAndInvalidate(sessionName, events);
  return 'sent';
}
