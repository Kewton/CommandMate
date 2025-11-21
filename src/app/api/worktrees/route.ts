/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktrees, getRepositories, getMessages } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

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
    const allCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];

    const worktreesWithStatus = await Promise.all(
      worktrees.map(async (worktree) => {
        // Check status for all CLI tools
        const sessionStatusByCli: {
          claude?: { isRunning: boolean; isWaitingForResponse: boolean };
          codex?: { isRunning: boolean; isWaitingForResponse: boolean };
          gemini?: { isRunning: boolean; isWaitingForResponse: boolean };
        } = {};

        let anyRunning = false;
        let anyWaiting = false;

        for (const cliToolId of allCliTools) {
          const cliTool = manager.getTool(cliToolId);
          const isRunning = await cliTool.isRunning(worktree.id);

          // Check if waiting for this CLI tool's response
          // Only consider it "waiting" if session is running AND last message is from user
          let isWaitingForResponse = false;
          if (isRunning) {
            const messages = getMessages(db, worktree.id, undefined, 1, cliToolId);
            // If there are messages and the last one is from user, we're waiting for response
            // If the last message is from assistant, the response is complete
            if (messages.length > 0 && messages[0].role === 'user') {
              isWaitingForResponse = true;
            }
          }

          sessionStatusByCli[cliToolId] = {
            isRunning,
            isWaitingForResponse,
          };

          if (isRunning) anyRunning = true;
          if (isWaitingForResponse) anyWaiting = true;
        }

        return {
          ...worktree,
          isSessionRunning: anyRunning,
          isWaitingForResponse: anyWaiting,
          sessionStatusByCli,
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
