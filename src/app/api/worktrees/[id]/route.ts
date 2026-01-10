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

      // Check status based on terminal state
      // - isWaitingForResponse: Interactive prompt (yes/no, multiple choice)
      // - isProcessing: Thinking indicator visible
      let isWaitingForResponse = false;
      let isProcessing = false;
      if (isRunning) {
        try {
          const output = await captureSessionOutput(params.id, cliToolId, 100);
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
              const hasInputPrompt = /^[>❯]\s*$/m.test(lastLines);
              if (!hasInputPrompt) {
                // Neither thinking nor input prompt - assume processing
                isProcessing = true;
              }
              // If hasInputPrompt && no thinking → "ready"
            }
          }

          // Clean up stale pending prompts if no prompt is showing
          if (!promptDetection.isPrompt) {
            const messages = getMessages(db, params.id, undefined, 10, cliToolId);
            const hasPendingPrompt = messages.some(
              msg => msg.messageType === 'prompt' && msg.promptData?.status !== 'answered'
            );
            if (hasPendingPrompt) {
              markPendingPromptsAsAnswered(db, params.id, cliToolId);
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
