/**
 * API Route: POST /api/worktrees/[id]/respond
 * Send response to CLI tool prompt (Claude/Codex/Gemini)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getMessageById, updatePromptData, getWorktreeById } from '@/lib/db';
import { sendKeys } from '@/lib/tmux';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { startPolling } from '@/lib/response-poller';
import { getAnswerInput, sanitizeAnswer } from '@/lib/prompt-detector';
import { broadcastMessage } from '@/lib/ws-server';

/**
 * POST /api/worktrees/[id]/respond
 *
 * Request body:
 * {
 *   "messageId": "uuid",
 *   "answer": "yes" | "no"
 * }
 *
 * Response:
 * {
 *   "success": true,
 *   "message": ChatMessage
 * }
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
): Promise<NextResponse> {
  try {
    const { messageId, answer } = await req.json();

    // Validation
    if (!messageId || !answer) {
      return NextResponse.json(
        { error: 'messageId and answer are required' },
        { status: 400 }
      );
    }

    const db = getDbInstance();

    // Get message
    const message = getMessageById(db, messageId);

    if (!message) {
      return NextResponse.json(
        { error: 'Message not found' },
        { status: 404 }
      );
    }

    if (message.messageType !== 'prompt') {
      return NextResponse.json(
        { error: 'Message is not a prompt' },
        { status: 400 }
      );
    }

    if (!message.promptData) {
      return NextResponse.json(
        { error: 'Prompt data not found' },
        { status: 400 }
      );
    }

    if (message.promptData.status === 'answered') {
      return NextResponse.json(
        { error: 'Prompt already answered' },
        { status: 400 }
      );
    }

    // Issue #193: Input sanitization (shared with prompt-response/route.ts via DRY)
    const sanitizeResult = sanitizeAnswer(answer);
    if (!sanitizeResult.valid) {
      return NextResponse.json(
        { error: sanitizeResult.error },
        { status: 400 }
      );
    }
    const sanitizedAnswer = sanitizeResult.sanitized;

    // Validate answer based on prompt type
    let input: string;

    // For multiple choice, check if answer is an option number or custom text
    if (message.promptData.type === 'multiple_choice') {
      const answerNum = parseInt(sanitizedAnswer, 10);

      // If answer is a number, validate it's one of the available options
      if (!isNaN(answerNum)) {
        const validNumbers = message.promptData.options.map(opt => opt.number);
        if (!validNumbers.includes(answerNum)) {
          return NextResponse.json(
            { error: 'Invalid choice. The selected option is not available.' },
            { status: 400 }
          );
        }

        // Use the number as input
        input = answerNum.toString();
      } else {
        // If answer is not a number, it's custom text input
        // Apply sanitization
        input = sanitizedAnswer;
      }
    } else {
      // For yes/no prompts, use the standard validation
      try {
        input = getAnswerInput(sanitizedAnswer, message.promptData.type);
      } catch (error: unknown) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        return NextResponse.json(
          { error: errorMessage },
          { status: 400 }
        );
      }
    }

    // Update prompt data
    const updatedPromptData = {
      ...message.promptData,
      status: 'answered' as const,
      answer,
      answeredAt: new Date().toISOString(),
    };

    updatePromptData(db, messageId, updatedPromptData);

    // Get worktree to verify it exists
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Use the CLI tool ID from the message (the tool that asked the prompt)
    const cliToolId = message.cliToolId || worktree.cliToolId || 'claude';

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Get session name for the CLI tool
    const sessionName = cliTool.getSessionName(params.id);

    // Send answer to tmux
    // For Claude prompts, send the answer and then Enter separately
    // This is because Claude's interactive menu responds immediately to the key press
    try {
      // Send the answer (number or y/n)
      await sendKeys(sessionName, input, false);
      console.log(`✓ Sent answer '${input}' to ${sessionName} (${cliTool.name})`);

      // Wait a moment for the input to be processed
      await new Promise(resolve => setTimeout(resolve, 100));

      // Send Enter
      await sendKeys(sessionName, '', true);
      console.log(`✓ Sent Enter to ${sessionName}`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${errorMessage}` },
        { status: 500 }
      );
    }

    // Broadcast updated message
    const updatedMessage = {
      ...message,
      promptData: updatedPromptData,
    };

    broadcastMessage('message_updated', {
      worktreeId: params.id,
      message: updatedMessage,
    });

    // Resume polling for CLI tool's next response
    startPolling(params.id, cliToolId);

    console.log(`✓ Resumed polling for ${params.id} (${cliToolId})`);

    return NextResponse.json({
      success: true,
      message: updatedMessage,
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
