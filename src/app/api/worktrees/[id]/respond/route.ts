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
import { getAnswerInput } from '@/lib/prompt-detector';
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

    // Validate answer based on prompt type
    let input: string;
    try {
      input = getAnswerInput(answer, message.promptData.type);
    } catch (error: any) {
      return NextResponse.json(
        { error: `Invalid answer: ${error.message}` },
        { status: 400 }
      );
    }

    // For multiple choice, validate the answer is one of the available options
    if (message.promptData.type === 'multiple_choice') {
      const answerNum = parseInt(answer, 10);
      const validNumbers = message.promptData.options.map(opt => opt.number);
      if (!validNumbers.includes(answerNum)) {
        return NextResponse.json(
          { error: `Invalid choice: ${answer}. Valid options are: ${validNumbers.join(', ')}` },
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

    // Get worktree to determine CLI tool
    const worktree = getWorktreeById(db, params.id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${params.id}' not found` },
        { status: 404 }
      );
    }

    // Determine which CLI tool to use
    const cliToolId = worktree.cliToolId || 'claude';

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Get session name for the CLI tool
    const sessionName = cliTool.getSessionName(params.id);

    // Send answer to tmux
    try {
      await sendKeys(sessionName, input, true);
      console.log(`✓ Sent answer '${input}' to ${sessionName} (${cliTool.name})`);
    } catch (error: any) {
      return NextResponse.json(
        { error: `Failed to send answer to tmux: ${error.message}` },
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
  } catch (error: any) {
    console.error('Failed to respond to prompt:', error);
    return NextResponse.json(
      { error: error.message || 'Internal server error' },
      { status: 500 }
    );
  }
}
