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
 * Fail-open on an unreadable pane, for the same reason `prompt-waiting-guard`
 * fails open: the cost of a wrong "ready" is a message the send path refuses
 * and the pump retries, while the cost of a wrong "not ready" is a relay that
 * expires holding an answer somebody is waiting for.
 *
 * @module lib/relay/relay-readiness
 */

import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/session/cli-session';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { createLogger } from '@/lib/logger';

const logger = createLogger('relay-readiness');

/** Why a delivery is being held, or `null` when it is not. */
export type RelayHoldReason = 'session_stopped' | 'generating';

/**
 * Whether a relay may be delivered into this session now.
 *
 * @returns `null` when the session can take the message, else why it cannot
 */
export async function findRelayHoldReason(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string
): Promise<RelayHoldReason | null> {
  try {
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
