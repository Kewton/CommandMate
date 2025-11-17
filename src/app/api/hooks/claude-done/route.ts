/**
 * API Route: POST /api/hooks/claude-done
 * Webhook called when Claude CLI completes a request
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage, updateSessionState, getMessages } from '@/lib/db';
import { captureClaudeOutput, getSessionName } from '@/lib/claude-session';
import { createLog } from '@/lib/log-manager';
import { broadcastMessage } from '@/lib/ws-server';

interface ClaudeDoneRequest {
  worktreeId: string;
}

interface ParsedOutput {
  content: string;
  summary?: string;
  logFileName?: string;
  requestId?: string;
}

/**
 * Parse tmux output to extract log information
 */
function parseClaudeOutput(output: string): ParsedOutput {
  const result: ParsedOutput = {
    content: output,
  };

  // Look for log file separator pattern
  // Format:
  // ───────────────────────────────────────────────────────────────
  // 📄 Session log: /path/to/.claude/logs/2025-01-17_10-30-45_abc123.jsonl
  // Request ID: abc123
  // Summary: Some summary text
  // ───────────────────────────────────────────────────────────────

  const logFileMatch = output.match(/📄 Session log: (.+?\/([^\/\s]+\.jsonl))/);
  if (logFileMatch) {
    result.logFileName = logFileMatch[2]; // Just the filename
  }

  const requestIdMatch = output.match(/Request ID: ([^\s\n]+)/);
  if (requestIdMatch) {
    result.requestId = requestIdMatch[1];
  }

  const summaryMatch = output.match(/Summary: (.+?)(?:\n─|$)/s);
  if (summaryMatch) {
    result.summary = summaryMatch[1].trim();
  }

  return result;
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

    // Get the last user message to pair with this response
    const messages = getMessages(db, body.worktreeId);
    const lastUserMessage = messages
      .filter((m) => m.role === 'user')
      .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime())[0];

    // Create Markdown log file
    if (lastUserMessage) {
      try {
        await createLog(
          body.worktreeId,
          lastUserMessage.content,
          parsed.content
        );
      } catch (error) {
        console.error('Failed to create log file:', error);
        // Continue even if log creation fails
      }
    }

    // Create Claude message in database
    const message = createMessage(db, {
      worktreeId: body.worktreeId,
      role: 'claude',
      content: parsed.content,
      summary: parsed.summary,
      timestamp: new Date(),
      logFileName: parsed.logFileName,
      requestId: parsed.requestId,
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
