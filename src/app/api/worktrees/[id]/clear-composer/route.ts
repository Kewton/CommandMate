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
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { hasSession } from '@/lib/tmux/tmux';
import { clearComposer } from '@/lib/session/composer-clear';
import { createLogger } from '@/lib/logger';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/clear-composer');

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: requestedWorktreeId } = await params;
  const id = canonicalWorktreeId(requestedWorktreeId);

  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 });
  }

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

    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    const result = await clearComposer(sessionName, cliToolId);
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
