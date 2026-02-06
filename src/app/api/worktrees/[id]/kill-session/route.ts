/**
 * API Route: POST /api/worktrees/:id/kill-session
 * Kills CLI tool sessions for a worktree
 *
 * Query parameters:
 * - cliTool: Optional. If specified, kills only that CLI tool's session.
 *            If not specified, kills all sessions (backward compatible).
 *
 * Issue #4: Added individual session termination support
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db-instance';
import { getWorktreeById, deleteSessionState, deleteAllMessages, deleteMessagesByCliTool } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux';
import { broadcast } from '@/lib/ws-server';
import { CLI_TOOL_IDS, type CLIToolType } from '@/lib/cli-tools/types';

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

    // Get cliTool from query parameter (Issue #4: individual session termination)
    const cliToolParam = request.nextUrl.searchParams.get('cliTool');
    const targetCliTool = cliToolParam as CLIToolType | null;

    // Validate cliTool parameter if provided
    if (targetCliTool && !CLI_TOOL_IDS.includes(targetCliTool)) {
      return NextResponse.json(
        { error: `Invalid cliTool: '${targetCliTool}'. Valid values: ${CLI_TOOL_IDS.join(', ')}` },
        { status: 400 }
      );
    }

    // Get CLI tool manager
    const manager = CLIToolManager.getInstance();

    // Determine which tools to kill
    const toolsToKill: CLIToolType[] = targetCliTool ? [targetCliTool] : [...CLI_TOOL_IDS];

    // Track killed sessions
    const killedSessions: string[] = [];
    let anySessionRunning = false;

    // Kill specified CLI tool sessions
    for (const cliToolId of toolsToKill) {
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

        // Stop poller if running (uses CLIToolManager.stopPollers for DIP compliance - MF1-001)
        manager.stopPollers(params.id, cliToolId);

        // Clean up session state
        deleteSessionState(db, params.id, cliToolId);
      }
    }

    if (!anySessionRunning) {
      const targetMsg = targetCliTool ? ` for ${targetCliTool}` : '';
      return NextResponse.json(
        { error: `No active sessions found${targetMsg} for this worktree` },
        { status: 404 }
      );
    }

    // Clear messages based on whether targeting specific CLI tool or all
    if (targetCliTool) {
      // Issue #4: Delete only messages for the specific CLI tool
      deleteMessagesByCliTool(db, params.id, targetCliTool);
    } else {
      // Delete all messages (backward compatible)
      deleteAllMessages(db, params.id);
    }

    // Broadcast session status change via WebSocket
    // Issue #4: Include cliTool in payload for targeted updates
    broadcast(params.id, {
      type: 'session_status_changed',
      worktreeId: params.id,
      isRunning: false,
      messagesCleared: true,
      cliTool: targetCliTool || null,
    });

    return NextResponse.json(
      {
        success: true,
        message: targetCliTool
          ? `Session killed successfully: ${killedSessions.join(', ')}`
          : `All sessions killed successfully: ${killedSessions.join(', ')}`,
        killedSessions,
        cliTool: targetCliTool || null,
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
