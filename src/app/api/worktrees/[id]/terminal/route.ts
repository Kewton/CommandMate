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
 *
 * Issue #1906 finishes the job on the other two halves of that report. The
 * route now (a) consults the same prompt guard `sendUserMessage` does before it
 * types anything, and (b) sends through `ICLITool.sendMessage` instead of
 * driving tmux itself — which is what removes the copilot special case that
 * flattened newlines and skipped every copilot-specific check. Nothing here
 * imports `lib/tmux` any more (design §4 D4).
 *
 * What it deliberately does NOT do is call `sendUserMessage`, which is what the
 * Issue text proposed. That function also writes a `chat_messages` row and
 * starts the response poller, and the Review-screen composer this route was
 * built for already POSTed the message to `/api/worktrees/:id/messages`
 * immediately afterwards — so routing through it would have put every
 * Review-screen message into History twice. The guard is what was missing, and
 * the guard is what was taken.
 *
 * Issue #2200 retired that composer, so this route now has **no caller in this
 * repository**: the worktree composer sends through
 * `POST /api/worktrees/:id/send` (`lib/api-client.ts`) and `commandmate send`
 * goes to the same place. It is kept as a published endpoint — the reason to
 * revisit the `sendUserMessage` question is a new caller, not this comment.
 * `tests/integration/api-send-prompt-waiting-1708.test.ts` pins both halves of
 * the arrangement so neither can drift while the route sits unused.
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
import {
  isPromptWaiting,
  promptWaitingMessage,
  PROMPT_WAITING_CODE,
} from '@/lib/session/prompt-waiting-guard';
import { createLogger } from '@/lib/logger';
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

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(target.cliToolId);

    // No auto-creation; return 404 if session does not exist. `isRunning` is the
    // ICLITool spelling of the `hasSession` check this used to make directly.
    const sessionExists = await cliTool.isRunning(id, instanceId);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found. Use startSession API to create a session first.' },
        { status: 404 }
      );
    }

    // Issue #1906: the same refusal `sendUserMessage` makes (#1708/#1737). This
    // route typed into whatever was on screen, so a Review-screen message sent
    // while a permission dialog was open landed in the DIALOG's input line: the
    // message never reached the agent, and the next `respond` had to answer a
    // prompt whose input already held it. 409 rather than 500 — the request was
    // well formed and the server is healthy, the session simply cannot accept a
    // message right now — with the same stable `code` the send route returns.
    const promptGuard = await isPromptWaiting(id, target.cliToolId, instanceId);
    if (promptGuard.waiting) {
      logger.info('terminal-send-refused-prompt-waiting', {
        worktreeId: id,
        cliToolId: target.cliToolId,
        reason: promptGuard.reason,
        blockedBy: promptGuard.blockedBy,
      });
      return NextResponse.json(
        { error: promptWaitingMessage(id, promptGuard.blockedBy), code: PROMPT_WAITING_CODE },
        { status: 409 }
      );
    }

    // Issue #1906: delegate to the tool. This route used to reach past
    // `ICLITool.sendMessage` into tmux — a raw `sendKeys` + delayed Enter for
    // copilot (newlines flattened to spaces, no submit verification, none of
    // copilot's own dialog/picker handling) and `sendMessageWithSubmitVerification`
    // for everything else, with a hand-tuned verify profile that had to be kept
    // in step with the real one by hand. Each tool's own `sendMessage` already
    // separates body from Enter and read-back-verifies the submit (#1471), so an
    // unconfirmed submit still throws here and still becomes a 500 — never a
    // false `{ success: true }`.
    //
    // The #559 note this replaces said copilot could not use its `sendMessage`
    // because `waitForPrompt` blocks. Measured on copilot 1.0.80: the composer
    // row `❯` is drawn at column 0 even mid-response, so `COPILOT_PROMPT_PATTERN`
    // matches on the first poll and the wait returns immediately. It only spends
    // its window when the composer is genuinely gone — i.e. a dialog is up, which
    // is exactly when typing was the wrong thing to do.
    await cliTool.sendMessage(id, command, instanceId);

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
