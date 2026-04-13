/**
 * Assistant Session API endpoint
 * DELETE /api/assistant/session
 *
 * Issue #649: Stop a global assistant session.
 * - Stops polling
 * - Kills the tmux session
 * - No DB operations
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType } from '@/lib/cli-tools/types';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { GLOBAL_SESSION_WORKTREE_ID } from '@/lib/session/global-session-constants';
import { stopGlobalSessionPolling } from '@/lib/polling/global-session-poller';
import { killSession } from '@/lib/tmux/tmux';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/assistant/session');

export async function DELETE(req: NextRequest) {
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

    // Stop polling
    stopGlobalSessionPolling(cliToolId);

    // Kill the tmux session
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);
    const sessionName = cliTool.getSessionName(GLOBAL_SESSION_WORKTREE_ID);

    const killed = await killSession(sessionName);

    logger.info('session:stopped', { cliToolId, sessionName, killed });

    return NextResponse.json({
      success: true,
      killed,
    });
  } catch (error) {
    logger.error('session-api-error:', {
      error: error instanceof Error ? error.message : String(error),
    });
    return NextResponse.json(
      { error: 'Failed to stop assistant session' },
      { status: 500 }
    );
  }
}
