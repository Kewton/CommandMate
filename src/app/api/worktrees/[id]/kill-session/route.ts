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
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, deleteSessionState, deleteAllMessages, deleteMessagesByCliTool, deleteMessagesByInstance, recomputeLastUserMessage, getAgentInstances, getAgentInstance } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux/tmux';
import { broadcast } from '@/lib/ws-server';
import { CLI_TOOL_IDS, isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('api/kill-session');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;
    const db = getDbInstance();

    // Check if worktree exists
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: `Worktree '${id}' not found` },
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

    // Issue #868: optional instance query param scopes the kill to a single
    // agent instance. The primary instance uses instanceId === cliToolId.
    const instanceParam = request.nextUrl.searchParams.get('instance');
    if (instanceParam && !isValidInstanceId(instanceParam)) {
      return NextResponse.json(
        { error: 'Invalid instance parameter' },
        { status: 400 }
      );
    }

    // Get CLI tool manager
    const manager = CLIToolManager.getInstance();

    // Build the list of (cliToolId, instanceId) pairs to kill.
    const targets: Array<{ cliToolId: CLIToolType; instanceId: string }> = [];

    if (instanceParam) {
      // Single-instance kill: resolve the backing CLI tool from (in priority order)
      // the explicit cliTool param, the registered instance, or the instance id
      // itself when it names a primary instance.
      const known = getAgentInstance(db, id, instanceParam);
      const resolvedTool: CLIToolType | null =
        (targetCliTool ?? null)
        ?? (known ? known.cliTool : null)
        ?? (isCliToolType(instanceParam) ? instanceParam : null);
      if (!resolvedTool) {
        return NextResponse.json(
          { error: 'Could not resolve CLI tool for the specified instance. Provide cliTool.' },
          { status: 400 }
        );
      }
      targets.push({ cliToolId: resolvedTool, instanceId: instanceParam });
    } else {
      // Determine which tools to kill, seeding each tool's primary instance
      // (instanceId === cliToolId) for backward compatibility.
      const toolsToKill: CLIToolType[] = targetCliTool ? [targetCliTool] : [...CLI_TOOL_IDS];
      const seen = new Set<string>();
      for (const tool of toolsToKill) {
        const key = `${tool}:${tool}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ cliToolId: tool, instanceId: tool });
        }
      }
      // Include any additional registered instances of the targeted tools so
      // their sessions are not orphaned.
      for (const ai of getAgentInstances(db, id)) {
        if (toolsToKill.includes(ai.cliTool)) {
          const key = `${ai.cliTool}:${ai.id}`;
          if (!seen.has(key)) {
            seen.add(key);
            targets.push({ cliToolId: ai.cliTool, instanceId: ai.id });
          }
        }
      }
    }

    // Track killed sessions
    const killedSessions: string[] = [];
    let anySessionRunning = false;

    // Kill targeted sessions
    for (const { cliToolId, instanceId } of targets) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(id, instanceId);

      if (isRunning) {
        anySessionRunning = true;
        const sessionName = cliTool.getSessionName(id, instanceId);
        const killed = await killSession(sessionName);

        if (killed) {
          killedSessions.push(sessionName);
          logger.info('killed-session:');
        }

        // Stop poller if running (uses CLIToolManager.stopPollers for DIP compliance - MF1-001)
        manager.stopPollers(id, cliToolId, instanceId);

        // Clean up session state for this instance
        deleteSessionState(db, id, cliToolId, instanceId);
      }
    }

    if (!anySessionRunning) {
      const targetMsg = instanceParam
        ? ` for instance ${instanceParam}`
        : (targetCliTool ? ` for ${targetCliTool}` : '');
      return NextResponse.json(
        { error: `No active sessions found${targetMsg} for this worktree` },
        { status: 404 }
      );
    }

    // Archive messages based on scope (Issue #168: logical archive, archived=1).
    if (instanceParam) {
      // Issue #868: archive only the targeted instance's messages.
      deleteMessagesByInstance(db, id, instanceParam);
    } else if (targetCliTool) {
      // Issue #4: Archive only messages for the specific CLI tool
      deleteMessagesByCliTool(db, id, targetCliTool);
    } else {
      // Archive all messages (backward compatible)
      deleteAllMessages(db, id);
    }

    // Issue #168 / #1171: recompute last_user_message from the remaining active
    // messages after archiving. A targeted (instance / CLI) kill only archives
    // that scope's messages, so other instances' un-archived user messages must
    // keep driving the sidebar metadata; only when none remain is it cleared.
    recomputeLastUserMessage(db, id);

    // Broadcast session status change via WebSocket
    // Issue #4: Include cliTool in payload for targeted updates
    broadcast(id, {
      type: 'session_status_changed',
      worktreeId: id,
      isRunning: false,
      messagesCleared: true,
      cliTool: targetCliTool || null,
      instance: instanceParam || null,
    });

    return NextResponse.json(
      {
        success: true,
        message: (instanceParam || targetCliTool)
          ? `Session killed successfully: ${killedSessions.join(', ')}`
          : `All sessions killed successfully: ${killedSessions.join(', ')}`,
        killedSessions,
        cliTool: targetCliTool || null,
        instance: instanceParam || null,
      },
      { status: 200 }
    );
  } catch (error: unknown) {
    logger.error('error-killing-sessions:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to kill sessions' },
      { status: 500 }
    );
  }
}
