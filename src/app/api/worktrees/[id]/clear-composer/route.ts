/**
 * Clear Composer API endpoint (Issue #1879).
 *
 * Empties the CLI's TUI input line for one agent instance and reports back
 * whether the composer is verifiably empty afterwards. Backs the [Clear] button
 * on the unsent-input bar, whose whole job is to let a human dispose of text
 * they can see but cannot edit through the read-only terminal.
 *
 * Why this is its own endpoint rather than another key in `special-keys`:
 * `C-u` is not a navigation key, and `NAVIGATION_KEY_VALUES` deliberately does
 * not carry it (`tmux.ts`). More importantly a single key send is not the
 * operation — #1878 §5-1 measured that one `C-u` clears nothing when the cursor
 * is at column 0 and only one row of a multi-row composer otherwise, so the
 * server has to loop and read back. `special-keys` stays what it is: fire keys,
 * verify nothing.
 *
 * Validation mirrors `special-keys/route.ts` layer for layer (JSON parse →
 * cliToolId → instanceId → worktree row → session existence), so this endpoint
 * is no more reachable than the one next to it. Rate limiting is intentionally
 * not implemented here for the same reason it is not there ([DR4-001]).
 *
 * Issue #3945: the clear takes the instance's input lock, so a Clear pressed
 * while a send is typing, checking or withdrawing its body waits for that send
 * to finish instead of erasing the body under it. A send that holds the
 * composer past the lock's wait gets a 409 `INSTANCE_INPUT_BUSY`, with nothing
 * cleared; so does a Clear whose session was replaced mid-way, which stops
 * before its next pass.
 */

import { NextRequest, NextResponse } from 'next/server';
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
// Issue #2865: imported from the tmux module this route was already allowlisted
// for (`.eslintrc.json` §4 D4), in place of the `hasSession` it used before.
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/tmux/session-ownership';
import { clearComposer } from '@/lib/session/composer-clear';
import {
  InstanceInputLockTimeoutError,
  InstanceInputOwnershipLostError,
  InstanceInputSessionReplacedError,
  withInstanceInputLock,
} from '@/lib/session/instance-input-lock';
import { createLogger } from '@/lib/logger';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/clear-composer');

/** Stable `code` for a Clear that could not get the composer from a send (Issue #3945). */
const INSTANCE_INPUT_BUSY_CODE = 'INSTANCE_INPUT_BUSY';

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: requestedWorktreeId } = await params;
  const id = canonicalWorktreeId(requestedWorktreeId);

  const parsed = await readJsonObjectBody<Record<string, unknown>>(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.body;

  try {
    const { cliToolId, instanceId } = body;

    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
    }

    if (instanceId !== undefined && (typeof instanceId !== 'string' || !isValidInstanceId(instanceId))) {
      return NextResponse.json({ error: 'Invalid instanceId parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(id, instanceId as string | undefined);

    // Issue #2865: a same-named session another CommandMate server created is not ours.
    const ownership = await checkSessionOwnership(sessionName, worktree.path);
    if (ownership.verdict === 'foreign') {
      return NextResponse.json(foreignSessionErrorBody(sessionName, ownership.sessionPath), { status: 409 });
    }
    if (ownership.verdict === 'absent') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    let result;
    try {
      // The clear runs whole under the lock, and each pass first asks whether
      // it still owns the composer (review-1 #3): a session replaced during a
      // capture or a redraw wait hands the composer to the new process's
      // writers, whose text is not this Clear's to erase.
      result = await withInstanceInputLock(sessionName, async (ticket) => {
        const cleared = await clearComposer(sessionName, cliToolId, { beforePass: () => ticket.isCurrent() });
        if (!ticket.isCurrent()) throw new InstanceInputOwnershipLostError(sessionName);
        return cleared;
      });
    } catch (error) {
      if (
        error instanceof InstanceInputLockTimeoutError ||
        error instanceof InstanceInputSessionReplacedError ||
        error instanceof InstanceInputOwnershipLostError
      ) {
        logger.warn('clear-composer-input-busy', { sessionName, error: error.message });
        return NextResponse.json({ error: error.message, code: INSTANCE_INPUT_BUSY_CODE }, { status: 409 });
      }
      throw error;
    }
    // Push the post-clear frame so the bar disappears without waiting for the
    // (WebSocket-throttled) poll. Best-effort, exactly as in special-keys.
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId as string | undefined);

    return NextResponse.json({
      success: true,
      cleared: result.cleared,
      passes: result.passes,
      composerState: result.state,
      remainingText: result.remainingText,
    });
  } catch (error) {
    logger.error('clear-composer-api-error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Failed to clear the composer' }, { status: 500 });
  }
}
