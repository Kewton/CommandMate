/**
 * "Can session A be typed into right now?" (Issue #2377).
 *
 * A relay's delivery is a message put into a composer that belongs to somebody
 * else's turn, so it has to ask the question `send` asks and one more besides.
 *
 *  - **Is the session alive?** A relay to a pane that was closed has nowhere to
 *    land; holding it until the deadline is the honest answer, not starting a
 *    session on the operator's behalf to receive an answer they may never read.
 *  - **Is it mid-turn?** This is the one `send` does NOT ask, and the Issue asks
 *    for it by name: typing into a `running` composer interrupts the turn that
 *    is running. The relay waits for `ready` instead — the ledger is durable, so
 *    waiting costs nothing but time.
 *
 * The prompt-dialog question is deliberately NOT asked here: `sendUserMessage`
 * already refuses a send that would land in an open dialog (#1708/#1737), and
 * duplicating that judgement would give the relay path its own second opinion
 * about a state the send path is the authority on. A refusal there is a retry
 * here.
 *
 * **Is it this server's session?** (Issue #3334) Asked first — before the
 * pane is read, and before `isRunning()`, which reads the pane (claude) or
 * resumes an event stream (opencode-v2) on its own.
 * `sendUserMessage` refuses a session another CommandMate server created under
 * the same name (#2865), but this check came first and read that pane to judge
 * it — the same order `sendUserMessage` itself was fixed out of. Such a session
 * holds the delivery (`foreign_session`): the ledger keeps the payload, and it
 * goes out if this server's own session comes back before the deadline.
 *
 * Fail-open on an unreadable pane, for the same reason `prompt-waiting-guard`
 * fails open: the cost of a wrong "ready" is a message the send path refuses
 * and the pump retries, while the cost of a wrong "not ready" is a relay that
 * expires holding an answer somebody is waiting for.
 *
 * @module lib/relay/relay-readiness
 */

import type Database from 'better-sqlite3';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resolveSessionName } from '@/lib/cli-tools/session-name';
import { checkWorktreeSessionOwnership } from '@/lib/cli-tools/worktree-session-ownership';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-readiness');

/** Why a delivery is being held, or `null` when it is not. */
export type RelayHoldReason = 'session_stopped' | 'generating' | 'foreign_session';

/**
 * Whether a relay may be delivered into this session now.
 *
 * @param db - The handle the worktree row is read from (Issue #3334); defaults
 *   to the server's
 * @returns `null` when the session can take the message, else why it cannot
 */
export async function findRelayHoldReason(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string,
  db?: Database.Database
): Promise<RelayHoldReason | null> {
  try {
    // Issue #3334: the session name `sendUserMessage` will address, checked
    // the way it checks it — before anything touches the session. That
    // includes `isRunning()`: it is not a bare existence test for every tool.
    // claude's reads the pane to judge its health, and opencode-v2's starts
    // re-subscribing to the event stream of whatever server sits in the
    // session's directory.
    const sessionName = resolveSessionName(cliToolId, worktreeId, instanceId);
    const ownership = await checkWorktreeSessionOwnership(worktreeId, sessionName, db);
    if (ownership === null || ownership.verdict === 'foreign') return 'foreign_session';
    if (ownership.verdict === 'absent') return 'session_stopped';

    const cliTool = CLIToolManager.getInstance().getTool(cliToolId);
    if (!(await cliTool.isRunning(worktreeId, instanceId))) return 'session_stopped';

    const output = await captureSessionOutput(
      worktreeId,
      cliToolId,
      STATUS_CAPTURE_LINES,
      instanceId
    );
    const status = detectSessionStatus(output, cliToolId);
    // Only `running` holds. `waiting` is a dialog, which is the send path's
    // judgement to make (and its refusal is a retry); `idle` and `ready` both
    // mean the composer is the thing on screen.
    return status.status === 'running' ? 'generating' : null;
  } catch (error) {
    logger.warn('relay-readiness-check-failed', {
      worktreeId,
      cliToolId,
      instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}
