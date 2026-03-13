/**
 * Special Keys API endpoint
 * Sends navigation keys (Up/Down/Enter/Escape/Tab/BTab) to tmux sessions
 * for TUI interaction (e.g., OpenCode selection lists).
 *
 * Issue #473: Multi-layer defense following terminal/route.ts pattern.
 * [DR1-001] Validation structure mirrors terminal/route.ts.
 * [DR4-001] Rate limiting intentionally not implemented (auth + IP + MAX_KEYS_LENGTH sufficient).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db-instance';
import { hasSession, isAllowedSpecialKey, sendSpecialKeysAndInvalidate } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/special-keys');

/** Maximum number of keys per request to prevent abuse */
const MAX_KEYS_LENGTH = 10;

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  // 0. JSON parse defense [DR4-002]
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
    const { cliToolId, keys } = body;

    // 1. cliToolId validation (isCliToolType)
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
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
    if (keys.length > MAX_KEYS_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid keys parameter' },
        { status: 400 }
      );
    }

    for (const key of keys) {
      if (!isAllowedSpecialKey(key)) {
        return NextResponse.json(
          { error: 'Invalid special key' },
          { status: 400 }
        );
      }
    }

    // 4. DB existence check
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // 5. Session existence check
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(params.id);

    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found' },
        { status: 404 }
      );
    }

    // 6. Send special keys and invalidate cache [DR1-003]
    await sendSpecialKeysAndInvalidate(sessionName, keys);

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
