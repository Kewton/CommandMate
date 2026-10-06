/**
 * Positive control for the session-ownership guard (Issue #3290).
 *
 * This is `src/app/api/worktrees/[id]/direct-input/route.ts` as it stood before
 * #3290 (develop `eeffb3fe`), body unchanged: it checks that the worktree row
 * exists and then hands the events to `sendDirectInput`, which looks the
 * session up by NAME only. It is kept so the guard can be shown to fail on the
 * route that actually shipped without the check —
 * `tests/unit/guards/worktree-route-session-ownership-3290.test.ts` runs both
 * of its stages against this file and expects each to object.
 *
 * Not a route: nothing serves it, and it lives outside `src/app`.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { sendDirectInput } from '@/lib/cli-tools/direct-input';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { MAX_DIRECT_INPUT_EVENTS, isDirectInputEvent } from '@/types/direct-input';

const logger = createLogger('api/direct-input');

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
    const { cliToolId, events, instanceId } = body;

    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json({ error: 'Invalid cliToolId parameter' }, { status: 400 });
    }

    if (instanceId !== undefined && (typeof instanceId !== 'string' || !isValidInstanceId(instanceId))) {
      return NextResponse.json({ error: 'Invalid instanceId parameter' }, { status: 400 });
    }

    if (
      !Array.isArray(events) ||
      events.length === 0 ||
      events.length > MAX_DIRECT_INPUT_EVENTS ||
      !events.every(isDirectInputEvent)
    ) {
      return NextResponse.json({ error: 'Invalid events parameter' }, { status: 400 });
    }

    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json({ error: 'Worktree not found' }, { status: 404 });
    }

    const result = await sendDirectInput(cliToolId, id, events, instanceId as string | undefined);
    if (result === 'session-not-found') {
      return NextResponse.json({ error: 'Session not found' }, { status: 404 });
    }

    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId as string | undefined);
    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('direct-input-api-error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json({ error: 'Failed to send direct input to terminal' }, { status: 500 });
  }
}
