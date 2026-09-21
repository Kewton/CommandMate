/**
 * Direct Input API endpoint (Issue #2765)
 *
 * Sends what the user typed straight to an agent's tmux pane — named keys
 * (`Enter`, `Up`, `C-a` …) and literal text — WITHOUT consulting the detection
 * layer. `special-keys` answers "which of the buttons this tool publishes did
 * you press?"; this route answers "the screen is one nobody can read, and the
 * key it wants is not a button".
 *
 * Same defence order as `special-keys/route.ts`. What is deliberately absent:
 *
 * - no per-tool vocabulary (`navigationKeys()`): the whole point is a key the
 *   tool did not declare. The vocabulary is the fixed `DIRECT_INPUT_KEY_VALUES`.
 * - no `prompt_waiting` guard: `/send` refuses while a dialog is up so a message
 *   is not typed into it, and direct input exists to type into exactly that.
 *
 * The authority is the one `/send` already grants an authenticated caller —
 * arbitrary text to an agent that runs shell commands — so nothing here widens
 * what a session can be made to do.
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
