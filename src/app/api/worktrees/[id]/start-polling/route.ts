/**
 * API Route: POST /api/worktrees/:id/start-polling
 * Manually starts polling for a CLI tool response
 * Useful for detecting prompts that appeared after the poller stopped
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { startPolling } from '@/lib/response-poller';
import type { CLIToolType } from '@/lib/cli-tools/types';

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

    // Validate CLI tool ID
    const validToolIds: CLIToolType[] = ['claude', 'codex', 'gemini'];
    if (!body.cliToolId || !validToolIds.includes(body.cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID. Must be one of: ${validToolIds.join(', ')}` },
        { status: 400 }
      );
    }

    // Start polling
    console.log(`[API] Manually starting polling for ${params.id} (${body.cliToolId})`);
    startPolling(params.id, body.cliToolId);

    return NextResponse.json({
      success: true,
      message: `Started polling for ${body.cliToolId} session`
    });
  } catch (error) {
    console.error('Error starting polling:', error);
    return NextResponse.json(
      { error: 'Failed to start polling' },
      { status: 500 }
    );
  }
}
