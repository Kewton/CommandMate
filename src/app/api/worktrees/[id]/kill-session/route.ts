/**
 * API Route: POST /api/worktrees/:id/kill-session
 * Kills the tmux Claude session for a worktree
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById } from '@/lib/db';
import { getSessionName, isClaudeRunning } from '@/lib/claude-session';
import { killSession } from '@/lib/tmux';
import { broadcast } from '@/lib/ws-server';

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

    // Check if session is running
    const isRunning = await isClaudeRunning(params.id);
    if (!isRunning) {
      return NextResponse.json(
        { error: 'No active session found for this worktree' },
        { status: 404 }
      );
    }

    // Kill the session
    const sessionName = getSessionName(params.id);
    const killed = await killSession(sessionName);

    if (!killed) {
      return NextResponse.json(
        { error: 'Failed to kill session' },
        { status: 500 }
      );
    }

    // Broadcast session status change via WebSocket
    broadcast(params.id, {
      type: 'session_status_changed',
      worktreeId: params.id,
      isRunning: false,
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
