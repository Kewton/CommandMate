/**
 * API Route: POST /api/worktrees/:id/kill-session
 * Kills CLI tool sessions for a worktree
 *
 * Query parameters:
 * - cliTool: Optional. If specified, kills only that CLI tool's session.
 *            If not specified, kills all sessions (backward compatible).
 *
 * Issue #4: Added individual session termination support
 * Issue #1905: kills through `ICLITool.killSession`, not `lib/tmux` directly
 */

import { NextRequest, NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById, deleteSessionState, deleteAllMessages, deleteMessagesByCliTool, deleteMessagesByInstance, recomputeLastUserMessage, getAgentInstances } from '@/lib/db';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { broadcast } from '@/lib/ws-server';
import { CLI_TOOL_IDS, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import {
  resolveSessionTargetStrict,
  describeSessionTargetConflict,
  INSTANCE_TOOL_CONFLICT,
} from '@/lib/session/resolve-session-target';
import { createLogger } from '@/lib/logger';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/kill-session');

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
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
      // Issue #1925: single-instance kill resolves through the one shared
      // resolver (design §4 D5). This route used to inline its own chain with
      // the explicit `?cliTool` ahead of the roster and no contradiction check,
      // so `--instance codex --cliTool claude` silently killed (or failed to
      // find) a Claude session under an instance the roster calls codex. The
      // roster now wins and the contradiction is refused: killing is a side
      // effect, so guessing which of the two declarations was meant is not an
      // option (DR2-009 / DR3-015).
      const resolution = resolveSessionTargetStrict(db, id, {
        instanceId: instanceParam,
        requestedCliTool: targetCliTool ?? undefined,
      });
      if (!resolution.ok) {
        return NextResponse.json(
          {
            error: describeSessionTargetConflict(resolution.conflict),
            code: INSTANCE_TOOL_CONFLICT,
            ...resolution.conflict,
          },
          { status: 400 }
        );
      }
      targets.push({
        cliToolId: resolution.target.cliToolId,
        instanceId: resolution.target.instanceId,
      });
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
    const failedSessions: string[] = [];
    let anySessionRunning = false;

    // Kill targeted sessions
    for (const { cliToolId, instanceId } of targets) {
      const cliTool = manager.getTool(cliToolId);
      const isRunning = await cliTool.isRunning(id, instanceId);

      if (!isRunning) continue;

      anySessionRunning = true;
      // `getSessionName` is part of the gateway too; it is only used here to
      // name the pane in the response and the log, never to address tmux.
      const sessionName = cliTool.getSessionName(id, instanceId);

      try {
        // Issue #1905 (design §4 D4): go through the CLITool gateway instead of
        // `lib/tmux`'s `killSession`. The direct tmux kill skipped every
        // tool-specific shutdown step — most visibly OpenCode's, where the SSE
        // subscription was never closed and the allocated port never returned,
        // so the pane died while a reconnect loop kept retrying a server that
        // was gone. `CopilotTool.killSession` was reachable from nowhere else,
        // which is why its defects went unnoticed. tmux kill still happens: it
        // is the fallback inside each tool's `killSession`.
        await cliTool.killSession(id, instanceId);
      } catch (error: unknown) {
        // One tool failing must not abandon the sessions after it in the list.
        // The pane is likely still alive, so its poller and session state are
        // deliberately left in place rather than torn down to match a kill that
        // did not happen.
        failedSessions.push(sessionName);
        logger.error('kill-session-failed', {
          cliTool: cliToolId,
          instance: instanceId,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }

      killedSessions.push(sessionName);
      logger.info('killed-session:');

      // Stop poller if running (uses CLIToolManager.stopPollers for DIP compliance - MF1-001)
      manager.stopPollers(id, cliToolId, instanceId);

      // Clean up session state for this instance
      deleteSessionState(db, id, cliToolId, instanceId);
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

    if (killedSessions.length === 0) {
      // Every live target refused to die. Reporting 200 here would archive the
      // messages and broadcast `isRunning: false` for panes that are still up,
      // which is the shape of failure Issue #1905 is about: a caller that has
      // no way to tell a completed kill from a skipped one.
      return NextResponse.json(
        {
          error: `Failed to kill sessions: ${failedSessions.join(', ')}`,
          failedSessions,
        },
        { status: 500 }
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
        ...(failedSessions.length > 0 ? { failedSessions } : {}),
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
