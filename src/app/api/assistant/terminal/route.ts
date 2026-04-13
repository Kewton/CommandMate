/**
 * Assistant Terminal API endpoint
 * POST /api/assistant/terminal
 *
 * Issue #649: Send commands to a global assistant session.
 * - No DB operations
 * - Validates cliToolId and command
 * - Sends keys to the active tmux session
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { hasSession, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { COPILOT_SEND_ENTER_DELAY_MS } from '@/config/copilot-constants';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/assistant/terminal');

/** Maximum command length to prevent DoS */
const MAX_COMMAND_LENGTH = 10000;

export async function POST(req: NextRequest) {
  try {
    const { cliToolId, command } = await req.json();

    // Validate cliToolId
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Validate command
    if (!command || typeof command !== 'string') {
      return NextResponse.json(
        { error: 'Missing command parameter' },
        { status: 400 }
      );
    }

    if (command.length > MAX_COMMAND_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid command parameter' },
        { status: 400 }
      );
    }

    // Check session exists
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);

    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found. Use start API to create a session first.' },
        { status: 404 }
      );
    }

    // Send command to tmux session (same pattern as terminal/route.ts)
    if (cliToolId === 'copilot') {
      const copilotCommand = command.replace(/\n+/g, ' ').trim();
      await sendKeys(sessionName, copilotCommand, false);
      await new Promise(resolve => setTimeout(resolve, COPILOT_SEND_ENTER_DELAY_MS));
      await sendSpecialKeys(sessionName, ['Enter']);
    } else {
      await sendKeys(sessionName, command);
    }

    // Invalidate cache after sending command
    invalidateCache(sessionName);

    return NextResponse.json({ success: true });
  } catch (error) {
    logger.error('terminal-api-error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to send command to terminal' },
      { status: 500 }
    );
  }
}
