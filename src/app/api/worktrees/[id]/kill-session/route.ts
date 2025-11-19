/**
 * API Route: POST /api/worktrees/:id/kill-session
 * Kills the tmux Claude session for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, deleteSessionState, deleteAllMessages } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux';
import { broadcast } from '@/lib/ws-server';
import { stopPolling } from '@/lib/response-poller';

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

    // Get CLI tool ID from request body (optional)
    let body: { cliToolId?: string } = {};
    try {
      body = await request.json();
    } catch {
      // No body provided, use worktree's default CLI tool
    }

    // Determine which CLI tool to use - prioritize request body, then worktree default
    const cliToolId = body.cliToolId || worktree.cliToolId || 'claude';

    // Validate CLI tool ID
    const validToolIds = ['claude', 'codex', 'gemini'];
    if (!validToolIds.includes(cliToolId)) {
      return NextResponse.json(
        { error: `Invalid CLI tool ID: ${cliToolId}` },
        { status: 400 }
      );
    }

    // Get CLI tool instance from manager
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(cliToolId as 'claude' | 'codex' | 'gemini');

    // Check if session is running
    const isRunning = await cliTool.isRunning(params.id);
    if (!isRunning) {
      return NextResponse.json(
        { error: 'No active session found for this worktree' },
        { status: 404 }
      );
    }

    // Kill the session
    const sessionName = cliTool.getSessionName(params.id);
    const killed = await killSession(sessionName);

    if (!killed) {
      return NextResponse.json(
        { error: 'Failed to kill session' },
        { status: 500 }
      );
    }

    // Stop poller if running
    stopPolling(params.id, cliToolId as 'claude' | 'codex' | 'gemini');

    // Clean up session state (important: reset line count tracking)
    deleteSessionState(db, params.id);

    // Clear all messages for this worktree (log files are preserved)
    deleteAllMessages(db, params.id);

    // Broadcast session status change via WebSocket
    broadcast(params.id, {
      type: 'session_status_changed',
      worktreeId: params.id,
      isRunning: false,
      messagesCleared: true,
    });

    return NextResponse.json(
      {
        success: true,
        message: `Session '${sessionName}' killed successfully`,
      },
      { status: 200 }
    );
  } catch (error: any) {
    console.error('Error killing session:', error);
    return NextResponse.json(
      { error: 'Failed to kill session' },
      { status: 500 }
    );
  }
}
