/**
 * API Route: /api/worktrees/:id
 * GET: Returns a specific worktree by ID
 * PATCH: Updates worktree properties (e.g., memo)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, updateWorktreeMemo, updateWorktreeLink, updateFavorite, updateStatus, updateCliToolId, getMessages, markPendingPromptsAsAnswered } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectThinking, stripAnsi } from '@/lib/cli-patterns';
import { detectPrompt } from '@/lib/prompt-detector';

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const db = getDbInstance();
    const worktree = getWorktreeById(db, params.id);

    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Check session status for all CLI tools (consistent with /api/worktrees)
    const manager = CLIToolManager.getInstance();
    const allCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];

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
      const isRunning = await cliTool.isRunning(params.id);

      // Check status based on messages
      // - isWaitingForResponse: There's ANY unanswered prompt (not just the last message)
      // - isProcessing: Last message is from user AND no pending prompts
      let isWaitingForResponse = false;
      let isProcessing = false;
      if (isRunning) {
        // Check recent messages (up to 10) for any pending prompt
        const messages = getMessages(db, params.id, undefined, 10, cliToolId);

        // First, check if there's any pending prompt
        const hasPendingPrompt = messages.some(
          msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
        );

        if (hasPendingPrompt) {
          // Check if Claude is actually waiting for prompt OR processing
          // If terminal shows no prompt, Claude has moved on (user answered via terminal)
          try {
            const output = await captureSessionOutput(params.id, cliToolId, 100);
            const cleanOutput = stripAnsi(output);
            const promptDetection = detectPrompt(cleanOutput);

            if (promptDetection.isPrompt) {
              // Terminal is actually showing a prompt - waiting for response
              isWaitingForResponse = true;
            } else {
              // Terminal is NOT showing a prompt - Claude is processing
              // Mark pending prompts as answered since user responded via terminal
              markPendingPromptsAsAnswered(db, params.id, cliToolId);
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
              const output = await captureSessionOutput(params.id, cliToolId, 100);
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

    return NextResponse.json(
      {
        ...worktree,
        isSessionRunning: anyRunning,
        isWaitingForResponse: anyWaiting,
        isProcessing: anyProcessing,
        sessionStatusByCli,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error fetching worktree:', error);
    return NextResponse.json(
      { error: 'Failed to fetch worktree' },
      { status: 500 }
    );
  }
}

export async function PATCH(
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
    const body = await request.json();

    // Update memo if provided
    if ('memo' in body) {
      updateWorktreeMemo(db, params.id, body.memo);
    }

    // Update link if provided
    if ('link' in body) {
      updateWorktreeLink(db, params.id, body.link);
    }

    // Update favorite if provided
    if ('favorite' in body && typeof body.favorite === 'boolean') {
      updateFavorite(db, params.id, body.favorite);
    }

    // Update status if provided
    if ('status' in body) {
      const validStatuses = ['todo', 'doing', 'done', null];
      if (validStatuses.includes(body.status)) {
        updateStatus(db, params.id, body.status);
      }
    }

    // Update CLI tool ID if provided
    if ('cliToolId' in body) {
      const validCliTools: CLIToolType[] = ['claude', 'codex', 'gemini'];
      if (validCliTools.includes(body.cliToolId)) {
        updateCliToolId(db, params.id, body.cliToolId);
      }
    }

    // Return updated worktree with session status
    const updatedWorktree = getWorktreeById(db, params.id);
    const manager = CLIToolManager.getInstance();
    const cliToolId = updatedWorktree?.cliToolId || 'claude';
    const cliTool = manager.getTool(cliToolId);
    const isRunning = await cliTool.isRunning(params.id);
    return NextResponse.json(
      { ...updatedWorktree, isSessionRunning: isRunning },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error updating worktree:', error);
    return NextResponse.json(
      { error: 'Failed to update worktree' },
      { status: 500 }
    );
  }
}
