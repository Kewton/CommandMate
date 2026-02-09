/**
 * API Route: POST /api/worktrees/[id]/prompt-response
 * Send response to CLI tool prompt detected from terminal output
 * This is a lightweight endpoint that doesn't require a database message ID
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { sendKeys, sendSpecialKeys } from '@/lib/tmux';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { captureSessionOutput } from '@/lib/cli-session';
import { detectPrompt, type PromptDetectionResult } from '@/lib/prompt-detector';
import { stripAnsi, buildDetectPromptOptions } from '@/lib/cli-patterns';

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
    let promptCheck: PromptDetectionResult | null = null;
    try {
      const currentOutput = await captureSessionOutput(params.id, cliToolId, 5000);
      const cleanOutput = stripAnsi(currentOutput);
      const promptOptions = buildDetectPromptOptions(cliToolId);
      promptCheck = detectPrompt(cleanOutput, promptOptions);

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
      // Issue #193: Claude Code AskUserQuestion uses cursor-based navigation
      // (Arrow/Space/Enter), not number input. Detect this format and send
      // the appropriate key sequence instead of typing the number.
      const isClaudeMultiChoice = cliToolId === 'claude'
        && promptCheck?.promptData?.type === 'multiple_choice'
        && /^\d+$/.test(answer);

      if (isClaudeMultiChoice && promptCheck?.promptData?.type === 'multiple_choice') {
        const targetNum = parseInt(answer, 10);
        const mcOptions = promptCheck.promptData.options;
        const defaultOption = mcOptions.find(o => o.isDefault);
        const defaultNum = defaultOption?.number ?? 1;
        const offset = targetNum - defaultNum;

        const keys: string[] = [];

        // Navigate to the target option with arrow keys
        if (offset > 0) {
          for (let i = 0; i < offset; i++) keys.push('Down');
        } else if (offset < 0) {
          for (let i = 0; i < Math.abs(offset); i++) keys.push('Up');
        }

        // Enter to select the highlighted option
        keys.push('Enter');

        await sendSpecialKeys(sessionName, keys);
      } else {
        // Standard CLI prompt: send text + Enter (y/n, Approve?, etc.)
        await sendKeys(sessionName, answer, false);

        // Wait a moment for the input to be processed
        await new Promise(resolve => setTimeout(resolve, 100));

        // Send Enter
        await sendKeys(sessionName, '', true);
      }
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
