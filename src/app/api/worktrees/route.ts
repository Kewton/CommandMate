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
import { detectThinking, stripAnsi } from '@/lib/cli-patterns';
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

          // Check status based on messages
          // - isWaitingForResponse: There's ANY unanswered prompt (not just the last message)
          // - isProcessing: Last message is from user AND no pending prompts
          let isWaitingForResponse = false;
          let isProcessing = false;
          if (isRunning) {
            // Check recent messages (up to 10) for any pending prompt
            const messages = getMessages(db, worktree.id, undefined, 10, cliToolId);

            // First, check if there's any pending prompt
            const hasPendingPrompt = messages.some(
              msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
            );

            if (hasPendingPrompt) {
              // Check if Claude is actually waiting for prompt OR processing
              // If terminal shows no prompt, Claude has moved on (user answered via terminal)
              try {
                const output = await captureSessionOutput(worktree.id, cliToolId, 100);
                const cleanOutput = stripAnsi(output);
                const promptDetection = detectPrompt(cleanOutput);

                if (promptDetection.isPrompt) {
                  // Terminal is actually showing a prompt - waiting for response
                  isWaitingForResponse = true;
                } else {
                  // Terminal is NOT showing a prompt - Claude is processing
                  // Mark pending prompts as answered since user responded via terminal
                  markPendingPromptsAsAnswered(db, worktree.id, cliToolId);
                  isProcessing = true;
                }
              } catch {
                // If capture fails, assume waiting for response
                isWaitingForResponse = true;
              }
            } else if (messages.length > 0) {
              const lastMessage = messages[0];
              // "processing" when last message is from user OR prompt was just answered
              // (Claude is working on the user's request)
              if (lastMessage.role === 'user' ||
                  (lastMessage.messageType === 'prompt' &&
                   lastMessage.promptData?.status === 'answered')) {
                // But first check terminal - maybe Claude is showing a prompt that isn't captured yet
                try {
                  const output = await captureSessionOutput(worktree.id, cliToolId, 100);
                  const cleanOutput = stripAnsi(output);
                  // Check for prompt in terminal (yes/no, multiple choice, etc.)
                  const promptDetection = detectPrompt(cleanOutput);
                  if (promptDetection.isPrompt) {
                    isWaitingForResponse = true;
                  } else {
                    // Check LAST few lines for input prompt first (takes priority)
                    // This handles case where thinking indicator is in buffer but Claude finished
                    const lastLines = cleanOutput.split('\n').slice(-10).join('\n');
                    const hasInputPrompt = /^[>❯]\s*$/m.test(lastLines);
                    if (hasInputPrompt) {
                      // Input prompt at end - Claude is ready for new message
                      // Both isProcessing and isWaitingForResponse stay false → "ready"
                    } else if (detectThinking(cliToolId, lastLines)) {
                      // Check thinking in last lines only (not entire buffer)
                      isProcessing = true;
                    } else {
                      // Neither prompt nor thinking in recent output
                      isProcessing = true;
                    }
                  }
                } catch {
                  // If capture fails, assume processing
                  isProcessing = true;
                }
              }
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
