/**
 * API Route: POST /api/worktrees/:id/kill-session
 * Kills all CLI tool sessions (Claude, Codex, Gemini) for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, deleteSessionState, deleteAllMessages } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux';
import { broadcast } from '@/lib/ws-server';
import { stopPolling } from '@/lib/response-poller';
import type { CLIToolType } from '@/lib/cli-tools/types';

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

    // Get CLI tool manager
    const manager = CLIToolManager.getInstance();
    const allToolIds: CLIToolType[] = ['claude', 'codex', 'gemini'];

    // Track killed sessions
    const killedSessions: string[] = [];
    let anySessionRunning = false;

    // Kill all CLI tool sessions
    for (const cliToolId of allToolIds) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(params.id);

      if (isRunning) {
        anySessionRunning = true;
        const sessionName = cliTool.getSessionName(params.id);
        const killed = await killSession(sessionName);

        if (killed) {
          killedSessions.push(sessionName);
          console.log(`[kill-session] Killed ${cliToolId} session: ${sessionName}`);
        }

        // Stop poller if running
        stopPolling(params.id, cliToolId);

        // Clean up session state
        deleteSessionState(db, params.id, cliToolId);
      }
    }

    if (!anySessionRunning) {
      return NextResponse.json(
        { error: 'No active sessions found for this worktree' },
        { status: 404 }
      );
    }

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
        message: `All sessions killed successfully: ${killedSessions.join(', ')}`,
        killedSessions,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    console.error('Error killing sessions:', error);
    return NextResponse.json(
      { error: 'Failed to kill sessions' },
      { status: 500 }
    );
  }
}
