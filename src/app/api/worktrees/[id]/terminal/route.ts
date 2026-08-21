/**
 * Terminal API endpoint
 * Sends commands to tmux sessions
 *
 * Issue #393: Security hardening
 * - isCliToolType() validation (D1-001)
 * - getWorktreeById() DB existence check (D1-002)
 * - CLIToolManager-based session name (D1-003)
 * - Session auto-creation removed (D1-004)
 * - MAX_COMMAND_LENGTH DoS protection (D1-006)
 * - Fixed-string error responses (D1-007, R4F002/R4F006/R4F007)
 *
 * Issue #1925: accepts an optional `instanceId` and resolves (tool, instance)
 * through `resolveSessionTarget`, the shared authority. Before that the route
 * derived the session name from the tool alone, so every non-primary instance
 * was unreachable from it (#1906).
 */

import { NextRequest, NextResponse } from 'next/server';
import { isCliToolType, isValidInstanceId } from '@/lib/cli-tools/types';
import {
  resolveSessionTargetStrict,
  describeSessionTargetConflict,
  INSTANCE_TOOL_CONFLICT,
} from '@/lib/session/resolve-session-target';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { hasSession, sendKeys, sendSpecialKeys } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { createLogger } from '@/lib/logger';
import { COPILOT_SEND_ENTER_DELAY_MS } from '@/config/copilot-constants';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';

const logger = createLogger('api/terminal');

/** Maximum command length to prevent DoS via large send-keys payloads (D1-006) */
const MAX_COMMAND_LENGTH = 10000;

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: requestedWorktreeId } = await params;
    const id = canonicalWorktreeId(requestedWorktreeId);
    const { cliToolId, command, instanceId: rawInstanceId } = await req.json();

    // Validate cliToolId against known CLI tool types
    if (!cliToolId || typeof cliToolId !== 'string' || !isCliToolType(cliToolId)) {
      return NextResponse.json(
        { error: 'Invalid cliToolId parameter' },
        { status: 400 }
      );
    }

    // Validate command parameter presence and type
    if (!command || typeof command !== 'string') {
      return NextResponse.json(
        { error: 'Missing command parameter' },
        { status: 400 }
      );
    }
    if (command.length > MAX_COMMAND_LENGTH) {
      return NextResponse.json(
        { error: 'Invalid command parameter' },
        { status: 400 }
      );
    }

    // Issue #1925: this route took no instance and always addressed the primary
    // one, so every non-primary session was unreachable from it (#1906). The id
    // is embedded in the tmux session name, hence the same identifier check the
    // other instance-aware routes use.
    if (rawInstanceId !== undefined && (typeof rawInstanceId !== 'string' || !isValidInstanceId(rawInstanceId))) {
      return NextResponse.json(
        { error: 'Invalid instanceId parameter' },
        { status: 400 }
      );
    }
    const instanceId: string | undefined = rawInstanceId;

    // Verify worktree exists in DB
    const db = getDbInstance();
    const worktree = getWorktreeById(db, id);
    if (!worktree) {
      return NextResponse.json(
        { error: 'Worktree not found' },
        { status: 404 }
      );
    }

    // Issue #1925: the roster, not the caller, declares which agent backs a
    // named instance (design §4 D5). Sending is a side effect, so a caller that
    // names a tool the roster contradicts is refused rather than resolved to a
    // guess — the tool id is half the session name, and typing into the wrong
    // session is not recoverable by the sender.
    const resolution = resolveSessionTargetStrict(db, id, {
      instanceId,
      requestedCliTool: cliToolId,
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
    const target = resolution.target;

    // Derive session name via CLIToolManager (validates via BaseCLITool.getSessionName)
    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(target.cliToolId);
    const sessionName = cliTool.getSessionName(id, instanceId);

    // No auto-creation; return 404 if session does not exist
    const sessionExists = await hasSession(sessionName);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found. Use startSession API to create a session first.' },
        { status: 404 }
      );
    }

    // Send command to tmux session (non-blocking for all tools).
    // Note: copilot sendMessage() was reverted due to waitForPrompt blocking issues (#559)
    if (target.cliToolId === 'copilot') {
      // Copilot CLI auto-enters multi-line mode when text exceeds pane width.
      // In multi-line mode, C-m (bundled with text) adds a newline instead of
      // submitting. Sending Enter as a separate command after a delay works.
      // Replace newlines with spaces to prevent Copilot CLI multi-line mode
      const copilotCommand = command.replace(/\n+/g, ' ').trim();
      await sendKeys(sessionName, copilotCommand, false);
      await new Promise(resolve => setTimeout(resolve, COPILOT_SEND_ENTER_DELAY_MS));
      await sendSpecialKeys(sessionName, ['Enter']);
    } else {
      // Issue #1470: the old `sendKeys(command)` batched body+C-m into a single
      // send-keys, which TUIs (claude/codex/gemini/opencode/vibe-local/antigravity)
      // treat as a bracketed paste that swallows the Enter — typed but unsent, yet
      // this route still returned { success: true }. Delegate to the shared
      // submit-verified helper so the body and Enter are separated and the submit
      // is read-back verified. A bounded, quick verify profile keeps the route
      // non-blocking (it must not re-introduce waitForPrompt-style blocking, #559);
      // if submit cannot be confirmed the helper throws -> 500 (never a false success).
      await sendMessageWithSubmitVerification({
        sessionName,
        message: command,
        cliToolId: target.cliToolId,
        verifyAttempts: 2,
        verifyDelayMs: 200,
      });
    }

    // Issue #405: Invalidate cache after sending command
    invalidateCache(sessionName);

    return NextResponse.json({ success: true });
  } catch (error) {
    // Fixed-string error response (no internal details exposed to client)
    logger.error('terminal-api-error:', { error: error instanceof Error ? error.message : String(error) });
    return NextResponse.json(
      { error: 'Failed to send command to terminal' },
      { status: 500 }
    );
  }
}
