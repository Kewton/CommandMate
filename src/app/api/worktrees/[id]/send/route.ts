/**
 * API Route: POST /api/worktrees/:id/send
 * Sends a user message to Claude for a specific worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, createMessage } from '@/lib/db';
import {
  startClaudeSession,
  isClaudeRunning,
  sendMessageToClaude,
  isClaudeInstalled,
} from '@/lib/claude-session';
import { startPolling } from '@/lib/claude-poller';

interface SendMessageRequest {
  content: string;
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

    // Check if Claude CLI is installed
    const claudeAvailable = await isClaudeInstalled();
    if (!claudeAvailable) {
      return NextResponse.json(
        { error: 'Claude CLI is not installed. Please install it first.' },
        { status: 503 }
      );
    }

    // Check if Claude session is running
    const running = await isClaudeRunning(params.id);

    // Start Claude session if not running
    if (!running) {
      const baseUrl = process.env.MCBD_BASE_URL || `http://localhost:${process.env.MCBD_PORT || 3000}`;

      try {
        await startClaudeSession({
          worktreeId: params.id,
          worktreePath: worktree.path,
          baseUrl,
        });
      } catch (error: any) {
        console.error('Failed to start Claude session:', error);
        return NextResponse.json(
          { error: `Failed to start Claude session: ${error.message}` },
          { status: 500 }
        );
      }
    }

    // Send message to Claude
    try {
      await sendMessageToClaude(params.id, body.content);
    } catch (error: any) {
      console.error('Failed to send message to Claude:', error);
      return NextResponse.json(
        { error: `Failed to send message to Claude: ${error.message}` },
        { status: 500 }
      );
    }

    // Create user message in database
    const message = createMessage(db, {
      worktreeId: params.id,
      role: 'user',
      content: body.content,
      timestamp: new Date(),
    });

    // Start polling for Claude's response
    startPolling(params.id);

    return NextResponse.json(message, { status: 201 });
  } catch (error) {
    console.error('Error sending message:', error);
    return NextResponse.json(
      { error: 'Failed to send message' },
      { status: 500 }
    );
  }
}
