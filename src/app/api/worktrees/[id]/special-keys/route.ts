/**
 * Special Keys API endpoint
 * Sends navigation keys (Up/Down/Left/Right/Enter/Escape/Tab/BTab) to tmux sessions
 * for TUI interaction (e.g., OpenCode selection lists, Copilot reasoning effort).
 *
 * Issue #473: Multi-layer defense following terminal/route.ts pattern.
 * [DR1-001] Validation structure mirrors terminal/route.ts.
 * [DR4-001] Rate limiting intentionally not implemented (auth + IP + MAX_KEYS_LENGTH sufficient).
 * Issue #2032: `isAllowedSpecialKey()` now also requires the key to be deliverable by
 * `sendSpecialKeys()`, so a vocabulary/transport divergence is answered 400 here
 * instead of escaping as a thrown error and being reported as 500. Rationale in the
 * `isAllowedSpecialKey` docblock (src/lib/tmux/tmux.ts).
 *
 * Issue #2046: the accepted vocabulary is now the REQUESTED TOOL'S, taken from
 * `ICLITool.navigationKeys()`, not one global list every tool shares. opencode
 * is driven by a `ctrl+x` leader followed by a bare letter, and a bare letter is
 * a character: accepting `a` for every tool would mean `POST {cliToolId:
 * "claude", keys:["a"]}` types an `a` into claude's composer. The tool lookup
 * therefore moves ahead of key validation — it is a synchronous registry read,
 * so nothing about the request's cost or its failure ordering changes for a
 * request that was valid before.
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { hasSession, isAllowedSpecialKey, sendSpecialKeysAndInvalidate } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';
import { broadcastTerminalSnapshotAfterInteraction } from '@/lib/realtime/terminal-broadcast';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/special-keys');

/** Maximum number of keys per request to prevent abuse */
const MAX_KEYS_LENGTH = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  // 0. JSON parse defense [DR4-002]
  const { id: requestedWorktreeId } = await params;
  const id = canonicalWorktreeId(requestedWorktreeId);
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json(
      { error: 'Invalid request body' },
      { status: 400 }
    );
  }

  try {
    const { cliToolId, keys, instanceId } = body;

    // 1. cliToolId validation (isCliToolType)
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Issue #868: optional instanceId selects a specific agent instance (defaults
    // to the primary). Validate format since it is embedded in the session name.
    if (instanceId !== undefined && (typeof instanceId !== 'string' || !isValidInstanceId(instanceId))) {
      return NextResponse.json(
        { error: 'Invalid instanceId parameter' },
        { status: 400 }
      );
    }

    // 2. keys type validation [DR4-004]
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k: unknown) => typeof k === 'string')) {
      return NextResponse.json(
        { error: 'Invalid keys parameter' },
        { status: 400 }
      );
    }

    // 3. keys content validation (isAllowedSpecialKey, MAX_KEYS_LENGTH) [DR2-004]
    //    isAllowedSpecialKey covers the requested tool's published vocabulary
    //    (Issue #2046) and the tmux transport allow-list (Issue #2032), so both a
    //    key this tool does not publish and a key the transport cannot deliver
    //    stop at 400 rather than reaching the send.
    if (keys.length > MAX_KEYS_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid keys parameter' },
        { status: 400 }
      );
    }

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const { keys: toolVocabulary } = cliTool.navigationKeys();

    for (const key of keys) {
      if (!isAllowedSpecialKey(key, toolVocabulary)) {
        return NextResponse.json(
          { error: 'Invalid special key' },
          { status: 400 }
        );
      }
    }

    // 4. DB existence check
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // 5. Session existence check
    const sessionName = cliTool.getSessionName(id, instanceId);

    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // 6. Send special keys and invalidate cache [DR1-003]
    await sendSpecialKeysAndInvalidate(sessionName, keys);
    void broadcastTerminalSnapshotAfterInteraction(id, cliToolId, instanceId as string | undefined);

    return NextResponse.json({ success: true });
  } catch (error) {
    // Fixed-string error response [DR4-003] - no internal details exposed
    logger.error('special-keys-api-error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to send special keys to terminal' },
      { status: 500 }
    );
  }
}
