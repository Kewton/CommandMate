/**
 * API Route: POST /api/worktrees/[id]/respond
 * Send response to CLI tool prompt (Claude/Codex/Gemini)
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getMessageById, updatePromptData, getWorktreeById } from '@/lib/db';
import { sendMessageWithEnter } from '@/lib/tmux';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { startPolling } from '@/lib/response-poller';
import { getAnswerInput } from '@/lib/prompt-detector';
import { broadcastMessage } from '@/lib/ws-server';
import { getErrorMessage, DANGEROUS_CONTROL_CHARS, MAX_ANSWER_LENGTH } from '@/lib/utils';

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

    // Answer field validation (SEC-009)
    if (typeof answer !== 'string' || answer.length > MAX_ANSWER_LENGTH) {
      return NextResponse.json(
        { error: `Answer must be a string of at most ${MAX_ANSWER_LENGTH} characters` },
        { status: 400 }
      );
    }

    if (DANGEROUS_CONTROL_CHARS.test(answer)) {
      return NextResponse.json(
        { error: 'Answer contains prohibited control characters' },
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

    // Validate answer based on prompt type
    let input: string;

    // For multiple choice, check if answer is an option number or custom text
    if (message.promptData.type === 'multiple_choice') {
      const answerNum = parseInt(answer, 10);

      // If answer is a number, validate it's one of the available options
      if (!isNaN(answerNum)) {
        const validNumbers = message.promptData.options.map(opt => opt.number);
        if (!validNumbers.includes(answerNum)) {
          return NextResponse.json(
            { error: `Invalid choice: ${answer}. Valid options are: ${validNumbers.join(', ')}` },
            { status: 400 }
          );
        }

        // Use the number as input
        input = answerNum.toString();
      } else {
        // If answer is not a number, it's custom text input
        // Use it as-is (no validation needed)
        input = answer;
      }
    } else {
      // For yes/no prompts, use the standard validation
      try {
        input = getAnswerInput(answer, message.promptData.type);
      } catch (error: unknown) {
        return NextResponse.json(
          { error: `Invalid answer: ${getErrorMessage(error)}` },
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

    // Send answer to tmux using unified pattern (Task-PRE-003)
    try {
      await sendMessageWithEnter(sessionName, input, 100);
      console.log(`✓ Sent answer '${input}' to ${sessionName} (${cliTool.name})`);
    } catch (error: unknown) {
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${getErrorMessage(error)}` },
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
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 }
    );
  }
}
