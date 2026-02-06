/**
 * API Route: GET /api/worktrees
 * Returns all worktrees sorted by updated_at DESC
 * Optionally filter by repository: GET /api/worktrees?repository=/path/to/repo
 */

import { NextRequest, NextResponse } from 'next/server';

// Force dynamic rendering - this route uses searchParams and database access
export const dynamic = 'force-dynamic';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktrees, getRepositories, getMessages, markPendingPromptsAsAnswered } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectThinking, stripAnsi, getCliToolPatterns } from '@/lib/cli-patterns';
import { detectPrompt } from '@/lib/prompt-detector';

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
          claude?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
          codex?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
          gemini?: { isRunning: boolean; isWaitingForResponse: boolean; isProcessing: boolean };
        } = {};

        let anyRunning = false;
        let anyWaiting = false;
        let anyProcessing = false;

        for (const cliToolId of allCliTools) {
          const cliTool = manager.getTool(cliToolId);
          const isRunning = await cliTool.isRunning(worktree.id);

          // Check status based on terminal state
          // - isWaitingForResponse: Interactive prompt (yes/no, multiple choice)
          // - isProcessing: Thinking indicator visible
          let isWaitingForResponse = false;
          let isProcessing = false;
          if (isRunning) {
            try {
              const output = await captureSessionOutput(worktree.id, cliToolId, 100);
              const cleanOutput = stripAnsi(output);

              // Check for interactive prompt (yes/no, multiple choice, etc.)
              const promptDetection = detectPrompt(cleanOutput);
              if (promptDetection.isPrompt) {
                isWaitingForResponse = true;
              } else {
                // Check LAST few lines for state detection (filter out empty lines)
                const nonEmptyLines = cleanOutput.split('\n').filter(line => line.trim() !== '');
                const lastLines = nonEmptyLines.slice(-15).join('\n');
                // Check for thinking indicator FIRST (takes priority)
                // Even if input prompt is visible, thinking indicator means processing
                if (detectThinking(cliToolId, lastLines)) {
                  isProcessing = true;
                } else {
                  // No thinking indicator - check for input prompt
                  // Issue #4: Use CLI tool-specific prompt pattern (fixes Codex spinner issue)
                  const { promptPattern } = getCliToolPatterns(cliToolId);
                  const hasInputPrompt = promptPattern.test(lastLines);
                  if (!hasInputPrompt) {
                    // Neither thinking nor input prompt - assume processing
                    isProcessing = true;
                  }
                  // If hasInputPrompt && no thinking → "ready"
                }
              }

              // Clean up stale pending prompts if no prompt is showing
              if (!promptDetection.isPrompt) {
                const messages = getMessages(db, worktree.id, undefined, 10, cliToolId);
                const hasPendingPrompt = messages.some(
                  msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
                );
                if (hasPendingPrompt) {
                  markPendingPromptsAsAnswered(db, worktree.id, cliToolId);
                }
              }
            } catch {
              // If capture fails, assume processing
              isProcessing = true;
            }
          }

          sessionStatusByCli[cliToolId] = {
            isRunning,
            isWaitingForResponse,
            isProcessing,
          };

          if (isRunning) anyRunning = true;
          if (isWaitingForResponse) anyWaiting = true;
          if (isProcessing) anyProcessing = true;
        }

        return {
          ...worktree,
          isSessionRunning: anyRunning,
          isWaitingForResponse: anyWaiting,
          isProcessing: anyProcessing,
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
