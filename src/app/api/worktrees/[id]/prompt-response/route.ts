/**
 * API Route: POST /api/worktrees/[id]/prompt-response
 * Send response to CLI tool prompt detected from terminal output
 * This is a lightweight endpoint that doesn't require a database message ID
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { sendKeys } from '@/lib/tmux';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectPrompt } from '@/lib/prompt-detector';
import { stripAnsi } from '@/lib/cli-patterns';

interface PromptResponseRequest {
  answer: string;
  cliTool?: CLIToolType;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body: PromptResponseRequest = await req.json();
    const { answer, cliTool: cliToolParam } = body;

    // Validation
    if (!answer) {
      return NextResponse.json(
        { error: 'answer is required' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Determine CLI tool ID
    const cliToolId: CLIToolType = cliToolParam || worktree.cliToolId || 'claude';

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if session is running
    const running = await cliTool.isRunning(params.id);
    if (!running) {
      return NextResponse.json(
        { error: `${cliTool.name} session is not running` },
        { status: 400 }
      );
    }

    // Get session name for the CLI tool
    const sessionName = cliTool.getSessionName(params.id);

    // Issue #161: Re-verify that a prompt is still active before sending keys.
    // This prevents a race condition where the prompt disappears between
    // detection (in current-output API) and sending (here), causing "1" to
    // be typed at the Claude user input prompt instead of a tool permission prompt.
    try {
      const currentOutput = await captureSessionOutput(params.id, cliToolId, 5000);
      const cleanOutput = stripAnsi(currentOutput);
      const promptCheck = detectPrompt(cleanOutput);

      if (!promptCheck.isPrompt) {
        return NextResponse.json({
          success: false,
          reason: 'prompt_no_longer_active',
          answer,
        });
      }
    } catch {
      // If capture fails, proceed with caution - don't block manual responses
      console.warn('[prompt-response] Failed to verify prompt state, proceeding with send');
    }

    // Send answer to tmux
    try {
      // Send the answer
      await sendKeys(sessionName, answer, false);

      // Wait a moment for the input to be processed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Send Enter
      await sendKeys(sessionName, '', true);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${errorMessage}` },
        { status: 500 }
      );
    }

    return NextResponse.json({
      success: true,
      answer,
    });
  } catch (error: unknown) {
    console.error('Failed to respond to prompt:', error);
    const errorMessage = error instanceof Error ? error.message : 'Internal server error';
    return NextResponse.json(
      { error: errorMessage },
      { status: 500 }
    );
  }
}
