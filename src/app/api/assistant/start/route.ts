/**
 * Assistant Start API endpoint
 * POST /api/assistant/start
 *
 * Issue #649: Start a global assistant session.
 * - No DB operations (no worktree record required)
 * - Validates cliToolId and working directory
 * - Creates tmux session + sends initial context
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { buildGlobalContext } from '@/lib/assistant/context-builder';
import { pollGlobalSession } from '@/lib/polling/global-session-poller';
import { getDbInstance } from '@/lib/db/db-instance';
import { isSystemDirectory } from '@/config/system-directories';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/assistant/start');

/** Maximum working directory path length */
const MAX_PATH_LENGTH = 4096;

export async function POST(req: NextRequest) {
  try {
    const { cliToolId, workingDirectory } = await req.json();

    // Validate cliToolId
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Validate workingDirectory
    if (!workingDirectory || typeof workingDirectory !== 'string') {
      return NextResponse.json(
        { error: 'Missing workingDirectory parameter' },
        { status: 400 }
      );
    }

    if (workingDirectory.length > MAX_PATH_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid workingDirectory parameter' },
        { status: 400 }
      );
    }

    // Null byte check (path traversal prevention)
    if (workingDirectory.includes('\0')) {
      return NextResponse.json(
        { error: 'Invalid workingDirectory parameter' },
        { status: 400 }
      );
    }

    // System directory check
    if (isSystemDirectory(workingDirectory)) {
      return NextResponse.json(
        { error: 'Invalid workingDirectory parameter' },
        { status: 400 }
      );
    }

    // Check CLI tool installation
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const installed = await cliTool.isInstalled();
    if (!installed) {
      return NextResponse.json(
        { error: `CLI tool '${cliToolId}' is not installed` },
        { status: 400 }
      );
    }

    // Start session using BaseCLITool.startSession with GLOBAL_SESSION_WORKTREE_ID
    await cliTool.startSession(GLOBAL_SESSION_WORKTREE_ID, workingDirectory);

    // Build and send initial context
    const db = getDbInstance();
    const context = buildGlobalContext(cliToolId, db);
    await cliTool.sendMessage(GLOBAL_SESSION_WORKTREE_ID, context);

    // Start polling for session output
    pollGlobalSession(cliToolId);

    const sessionName = cliTool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);

    logger.info('session:started', { cliToolId, sessionName });

    return NextResponse.json({
      success: true,
      sessionName,
    });
  } catch (error) {
    logger.error('start-api-error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to start assistant session' },
      { status: 500 }
    );
  }
}
