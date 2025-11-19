/**
 * API Route: POST /api/hooks/claude-done
 * Webhook called when Claude CLI completes a request
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage, updateSessionState } from '@/lib/db';
import { captureClaudeOutput } from '@/lib/claude-session';
import { broadcastMessage } from '@/lib/ws-server';
import { parseClaudeOutput } from '@/lib/claude-output';
import { recordClaudeConversation } from '@/lib/conversation-logger';

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
    } catch (error: any) {
      console.error('Failed to capture Claude output:', error);
      return NextResponse.json(
        { error: `Failed to capture Claude output: ${error.message}` },
        { status: 500 }
      );
    }

    // Parse output to extract log information
    const parsed = parseClaudeOutput(output);

    // Create Markdown log file alongside latest user prompt
    await recordClaudeConversation(db, body.worktreeId, parsed.content);

    // Create Claude message in database
    const message = createMessage(db, {
      worktreeId: body.worktreeId,
      role: 'claude',
      content: parsed.content,
      summary: parsed.summary,
      timestamp: new Date(),
      logFileName: parsed.logFileName,
      requestId: parsed.requestId,
      messageType: 'normal',
    });

    // Update session state
    const lineCount = output.split('\n').length;
    updateSessionState(db, body.worktreeId, lineCount);

    // Broadcast message to WebSocket clients
    broadcastMessage('message', {
      worktreeId: body.worktreeId,
      message,
    });

    console.log(`✓ Processed Claude response for worktree: ${body.worktreeId}`);

    return NextResponse.json(
      {
        success: true,
        messageId: message.id,
        summary: parsed.summary,
      },
      { status: 200 }
    );
  } catch (error) {
    console.error('Error processing Claude done hook:', error);
    return NextResponse.json(
      { error: 'Failed to process Claude done hook' },
      { status: 500 }
    );
  }
}
