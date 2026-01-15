/**
 * API Route: POST /api/worktrees/:id/send
 * Sends a user message to a CLI tool (Claude/Codex/Gemini) for a specific worktree
 *
 * Flow:
 * 1. Validate worktree exists
 * 2. Validate request body (content required)
 * 3. Validate CLI tool (defaults to claude)
 * 4. Ensure CLI tool session is running
 * 5. Save pending assistant response (Issue #53)
 * 6. Send message to CLI tool
 * 7. Create user message in database
 * 8. Start polling for response
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage, updateLastUserMessage, clearInProgressMessageId } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { startPolling } from '@/lib/response-poller';
import { savePendingAssistantResponse } from '@/lib/assistant-response-saver';

/** Supported CLI tool IDs */
const VALID_CLI_TOOL_IDS: CLIToolType[] = ['claude', 'codex', 'gemini'];

/** Default CLI tool when not specified */
const DEFAULT_CLI_TOOL: CLIToolType = 'claude';

interface SendMessageRequest {
  content: string;
  cliToolId?: CLIToolType;  // Optional: override the worktree's default CLI tool
}

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export async function POST(
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
    const body: SendMessageRequest = await request.json();

    // Validate content
    if (!body.content || typeof body.content !== 'string' || body.content.trim() === '') {
      return NextResponse.json(
        { error: 'Message content is required and must be a non-empty string' },
        { status: 400 }
      );
    }

    // Determine which CLI tool to use (priority: request > worktree setting > default)
    const cliToolId = body.cliToolId || worktree.cliToolId || DEFAULT_CLI_TOOL;

    // Validate CLI tool ID
    if (!VALID_CLI_TOOL_IDS.includes(cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID: ${cliToolId}. Must be one of: ${VALID_CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId);

    // Check if CLI tool is installed
    const toolAvailable = await cliTool.isInstalled();
    if (!toolAvailable) {
      return NextResponse.json(
        { error: `${cliTool.name} is not installed. Please install it first.` },
        { status: 503 }
      );
    }

    // Check if CLI tool session is running
    const running = await cliTool.isRunning(params.id);

    // Start CLI tool session if not running
    if (!running) {
      try {
        await cliTool.startSession(params.id, worktree.path);
      } catch (error: unknown) {
        console.error(`Failed to start ${cliTool.name} session:`, error);
        return NextResponse.json(
          { error: `Failed to start ${cliTool.name} session: ${getErrorMessage(error)}` },
          { status: 500 }
        );
      }
    }

    // Generate timestamp for user message BEFORE saving pending response
    // This ensures timestamp ordering: assistantResponse < userMessage
    const userMessageTimestamp = new Date();

    // Save any pending assistant response before sending the new user message
    // This captures the CLI tool's response to the previous user message
    try {
      await savePendingAssistantResponse(db, params.id, cliToolId, userMessageTimestamp);
    } catch (error) {
      // Log but don't fail - user message should still be saved
      console.error(`[send] Failed to save pending assistant response:`, error);
    }

    // Send message to CLI tool
    try {
      await cliTool.sendMessage(params.id, body.content);
    } catch (error: unknown) {
      console.error(`Failed to send message to ${cliTool.name}:`, error);
      return NextResponse.json(
        { error: `Failed to send message to ${cliTool.name}: ${getErrorMessage(error)}` },
        { status: 500 }
      );
    }

    // Create user message in database with CLI tool ID
    // Use the pre-generated timestamp for consistency
    const message = createMessage(db, {
      worktreeId: params.id,
      role: 'user',
      content: body.content,
      messageType: 'normal',
      timestamp: userMessageTimestamp,
      cliToolId,
    });

    // Update last user message for worktree
    updateLastUserMessage(db, params.id, body.content, userMessageTimestamp);

    // Clear in-progress message ID (session state is managed by savePendingAssistantResponse)
    clearInProgressMessageId(db, params.id, cliToolId);
    console.log(`✓ Cleared in-progress message for ${params.id} (${cliToolId})`);

    // Start polling for CLI tool's response
    startPolling(params.id, cliToolId);

    return NextResponse.json(message, { status: 201 });
  } catch (error: unknown) {
    console.error('Error sending message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
