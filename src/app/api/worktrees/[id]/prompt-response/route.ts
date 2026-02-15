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
import type { PromptType } from '@/types/models';

interface PromptResponseRequest {
  answer: string;
  cliTool?: CLIToolType;
  /** Issue #287: Prompt type from client-side detection (fallback when promptCheck fails) */
  promptType?: PromptType;
  /** Issue #287: Default option number from client-side detection (fallback when promptCheck fails) */
  defaultOptionNumber?: number;
}

export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const body: PromptResponseRequest = await req.json();
    const { answer, cliTool: cliToolParam, promptType: bodyPromptType, defaultOptionNumber: bodyDefaultOptionNumber } = body;

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
      //
      // Issue #287: When promptCheck is null (capture failed), fall back to
      // body.promptType to determine if cursor-key navigation is needed.
      // This prevents the bug where a failed re-verification causes
      // multiple_choice prompts to be sent as plain text.
      const isClaudeMultiChoice = cliToolId === 'claude'
        && (promptCheck?.promptData?.type === 'multiple_choice'
            || (promptCheck === null && bodyPromptType === 'multiple_choice'))
        && /^\d+$/.test(answer);

      if (isClaudeMultiChoice) {
        const targetNum = parseInt(answer, 10);

        // Issue #287: Use promptCheck data when available, fall back to body fields
        let defaultNum: number;
        let mcOptions: Array<{ number: number; label: string; isDefault?: boolean }> | null = null;

        if (promptCheck?.promptData?.type === 'multiple_choice') {
          // Primary path: use fresh promptCheck data
          mcOptions = promptCheck.promptData.options;
          const defaultOption = mcOptions.find(o => o.isDefault);
          defaultNum = defaultOption?.number ?? 1;
        } else {
          // Fallback path (Issue #287): promptCheck is null, use body fields
          defaultNum = bodyDefaultOptionNumber ?? 1;
        }

        const offset = targetNum - defaultNum;

        // Detect multi-select (checkbox) prompts by checking for [ ] in option labels.
        // Multi-select prompts require: Space to toggle checkbox -> navigate to "Next" -> Enter.
        // Single-select prompts require: navigate to option -> Enter.
        // Note: multi-select detection is only possible when promptCheck succeeded (mcOptions available).
        const isMultiSelect = mcOptions !== null && mcOptions.some(o => /^\[[ x]\] /.test(o.label));

        if (isMultiSelect && mcOptions !== null) {
          // Multi-select: toggle checkbox, then navigate to "Next" and submit
          const checkboxCount = mcOptions.filter(o => /^\[[ x]\] /.test(o.label)).length;

          const keys: string[] = [];

          // 1. Navigate to target option
          if (offset > 0) {
            for (let i = 0; i < offset; i++) keys.push('Down');
          } else if (offset < 0) {
            for (let i = 0; i < Math.abs(offset); i++) keys.push('Up');
          }

          // 2. Space to toggle checkbox
          keys.push('Space');

          // 3. Navigate to "Next" button (positioned right after all checkbox options)
          const downToNext = checkboxCount - targetNum + 1;
          for (let i = 0; i < downToNext; i++) keys.push('Down');

          // 4. Enter to submit
          keys.push('Enter');

          await sendSpecialKeys(sessionName, keys);
        } else {
          // Single-select: navigate and Enter to select
          const keys: string[] = [];

          if (offset > 0) {
            for (let i = 0; i < offset; i++) keys.push('Down');
          } else if (offset < 0) {
            for (let i = 0; i < Math.abs(offset); i++) keys.push('Up');
          }

          keys.push('Enter');
          await sendSpecialKeys(sessionName, keys);
        }
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
