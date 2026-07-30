/**
 * API Route: POST /api/hooks/claude-done
 * Webhook called when Claude CLI completes a request
 *
 * Superseded by `/api/hooks/agent-event` (Issue #1549) and kept for the hook
 * configurations already pointing here. It still owns what it always owned —
 * capturing the pane and turning it into a message — and delegates the stop
 * event itself to the shared handler, so a task governed by a contract reaches
 * the same state whichever endpoint the agent was wired to.
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, createMessage, updateSessionState } from '@/lib/db';
import { captureClaudeOutput } from '@/lib/session/claude-session';
import { broadcastMessage } from '@/lib/ws-server';
import { parseClaudeOutput } from '@/lib/claude-output';
import { recordClaudeConversation } from '@/lib/conversation-logger';
import { applyAgentStopEvent } from '@/lib/hooks/agent-event-service';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/hooks-claude-done');

interface ClaudeDoneRequest {
  worktreeId: string;
}

export async function POST(request: NextRequest) {
  try {
    const db = getDbInstance();

    // Parse request body
    const body: ClaudeDoneRequest = await request.json();

    // Validate request
    if (!body.worktreeId || typeof body.worktreeId !== 'string') {
      return NextResponse.json(
        { error: 'worktreeId is required and must be a string' },
        { status: 400 }
      );
    }

    // Check if worktree exists
    const worktree = getWorktreeById(db, body.worktreeId);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${body.worktreeId}' not found` },
        { status: 404 }
      );
    }

    // Capture Claude output from tmux
    let output: string;
    try {
      output = await captureClaudeOutput(body.worktreeId, 10000);
    } catch (error: unknown) {
      logger.error('failed-to-capture-claude-output:', { error: error instanceof Error ? error.message : String(error) });
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return NextResponse.json(
        { error: `Failed to capture Claude output: ${errorMessage}` },
        { status: 500 }
      );
    }

    // Parse output to extract log information
    const parsed = parseClaudeOutput(output);

    // Create Markdown log file alongside latest user prompt
    await recordClaudeConversation(db, body.worktreeId, parsed.content, 'claude');

    // Create Claude message in database
    const message = createMessage(db, {
      worktreeId: body.worktreeId,
      role: 'assistant',
      content: parsed.content,
      summary: parsed.summary,
      timestamp: new Date(),
      logFileName: parsed.logFileName,
      requestId: parsed.requestId,
      messageType: 'normal',
      cliToolId: 'claude',
    });

    // Update session state
    const lineCount = output.split('\n').length;
    updateSessionState(db, body.worktreeId, 'claude', lineCount);

    // Broadcast message to WebSocket clients
    broadcastMessage('message', {
      worktreeId: body.worktreeId,
      message,
    });

    // Same effects as POST /api/hooks/agent-event with {tool:'claude',event:'stop'}.
    // Runs last so a task-log or verification failure cannot cost this endpoint
    // the message it exists to record.
    await applyAgentStopEvent(db, worktree, 'claude', 'claude');

    logger.info('processed-claude-response-for-worktree:');

    return NextResponse.json(
      {
        success: true,
        messageId: message.id,
        summary: parsed.summary,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-processing-claude-done-hook:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to process Claude done hook' },
      { status: 500 }
    );
  }
}
