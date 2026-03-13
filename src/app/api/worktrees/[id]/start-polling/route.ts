/**
 * API Route: POST /api/worktrees/:id/start-polling
 * Manually starts polling for a CLI tool response
 * Useful for detecting prompts that appeared after the poller stopped
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { startPolling } from '@/lib/polling/response-poller';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/start-polling');

interface StartPollingRequest {
  cliToolId: CLIToolType;
}

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Parse request body
    const body: StartPollingRequest = await request.json();

    // Issue #368: Use CLI_TOOL_IDS instead of hardcoded array (DRY)
    if (!body.cliToolId || !(CLI_TOOL_IDS as readonly string[]).includes(body.cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID. Must be one of: ${CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Start polling
    logger.info('manually-starting-polling-for');
    startPolling(params.id, body.cliToolId);

    return NextResponse.json({
      success: true,
      message: `Started polling for ${body.cliToolId} session`
    });
  } catch (error) {
    logger.error('error-starting-polling:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to start polling' },
      { status: 500 }
    );
  }
}
