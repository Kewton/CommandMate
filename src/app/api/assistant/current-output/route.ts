/**
 * Assistant Current Output API endpoint
 * GET /api/assistant/current-output
 *
 * Issue #649: Capture terminal output from a global assistant session.
 * - No DB operations
 * - Uses tmux capturePane to get current terminal output
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { hasSession, capturePane } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/assistant/current-output');

/** Default capture lines for output */
const DEFAULT_CAPTURE_LINES = 1000;

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url);
    const cliToolId = searchParams.get('cliToolId');

    // Validate cliToolId
    if (!cliToolId || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Derive session name
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);

    // Check session exists
    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json({
        output: '',
        sessionActive: false,
      });
    }

    // Capture output
    const output = await capturePane(sessionName, DEFAULT_CAPTURE_LINES);

    return NextResponse.json({
      output,
      sessionActive: true,
    });
  } catch (error) {
    logger.error('current-output-api-error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to capture assistant output' },
      { status: 500 }
    );
  }
}
