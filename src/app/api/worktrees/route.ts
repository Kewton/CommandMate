/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktrees, getRepositories, getLastMessage } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';

export async function GET(request: NextRequest) {
  try {
    const db = getDbInstance();

    // Check for repository filter query parameter
    const searchParams = request.nextUrl?.searchParams;
    const repositoryFilter = searchParams?.get('repository');

    // Get worktrees (with optional filter)
    const worktrees = getWorktrees(db, repositoryFilter || undefined);

    // Check session status and response status for each worktree
    const manager = CLIToolManager.getInstance();

    const worktreesWithStatus = await Promise.all(
      worktrees.map(async (worktree) => {
        // Determine which CLI tool to use
        const cliToolId = worktree.cliToolId || 'claude';
        const cliTool = manager.getTool(cliToolId);

        // Check if session is running
        const isRunning = await cliTool.isRunning(worktree.id);

        // Check if waiting for CLI tool's response
        // Criteria: session is running AND last message is from user
        let isWaitingForResponse = false;
        if (isRunning) {
          const lastMessage = getLastMessage(db, worktree.id);
          isWaitingForResponse = lastMessage?.role === 'user';
        }

        return {
          ...worktree,
          isSessionRunning: isRunning,
          isWaitingForResponse,
        };
      })
    );

    // Get repository list
    const repositories = getRepositories(db);

    return NextResponse.json(
      {
        worktrees: worktreesWithStatus,
        repositories,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error fetching worktrees:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worktrees' },
      { status: 500 }
    );
  }
}
