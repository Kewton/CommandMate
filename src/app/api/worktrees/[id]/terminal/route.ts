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
import { readJsonObjectBody } from '@/lib/api/read-json-body';
import { isCliToolType, isValidInstanceId, type CLIToolType } from '@/lib/cli-tools/types';
import {
  resolveSessionTargetStrict,
} from '@/lib/session/resolve-session-target';
import { sessionTargetConflictResponse } from '@/lib/session/session-target-conflict-response';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import {
  isPromptWaiting,
  promptWaitingMessage,
  PROMPT_WAITING_CODE,
} from '@/lib/session/prompt-waiting-guard';
import { createLogger } from '@/lib/logger';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { PLAN_REVIEW_SEND_REFUSED_CODE } from '@/lib/session/send-attempt-types';
import { commandCodePlanReviewSendMessage, respondAgentFor } from '@/lib/session/respond-target';
import { canonicalWorktreeId } from '@/lib/git/git-route-worktree';
import { checkSessionOwnership, foreignSessionErrorBody } from '@/lib/cli-tools/session-ownership';

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
    const parsed = await readJsonObjectBody(req);
    if (!parsed.ok) return parsed.response;
    const { cliToolId, command, instanceId: rawInstanceId } = parsed.body;

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
      return sessionTargetConflictResponse(resolution.conflict);
    }
    const target = resolution.target;

    // Issue #4049: the refusals' `respond` must reach the tool this request
    // named. A bare `respond` resolves as a request naming nothing does, so the
    // tool is named only when no instance was and it is not that one. Asked
    // only when a refusal is written.
    const respondAgent = (): CLIToolType | undefined => {
      if (instanceId) return undefined;
      const unqualified = resolveSessionTargetStrict(db, id, {});
      return respondAgentFor(cliToolId, instanceId, unqualified.ok ? unqualified.target.cliToolId : undefined);
    };

    // Issue #4063: the plan review refusal's tool. Only Command Code shows
    // one, and its primary — no instance, or the tool's own id (#868) — is
    // reached by a bare `respond` only when it is the worktree default.
    const planReviewRespondAgent = (): CLIToolType | undefined => {
      if (instanceId && instanceId !== target.cliToolId) return undefined;
      const unqualified = resolveSessionTargetStrict(db, id, {});
      return respondAgentFor(target.cliToolId, undefined, unqualified.ok ? unqualified.target.cliToolId : undefined);
    };

    const manager = CLIToolManager.getInstance();
    const cliTool = manager.getTool(target.cliToolId);

    // Issue #2865: a same-named session another CommandMate server created is
    // never typed into.
    const sessionName = cliTool.getSessionName(id, instanceId);
    const ownership = await checkSessionOwnership(sessionName, worktree.path);
    if (ownership.verdict === 'foreign') {
      return NextResponse.json(foreignSessionErrorBody(sessionName, ownership.sessionPath), { status: 409 });
    }

    // No auto-creation; return 404 if session does not exist. `isRunning` is the
    // ICLITool spelling of the `hasSession` check this used to make directly.
    const sessionExists = await cliTool.isRunning(id, instanceId);
    if (!sessionExists) {
      return NextResponse.json(
        { error: 'Session not found. Start one first, for example with `commandmate send <worktree-id> "message"`.' },
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
        { error: promptWaitingMessage(id, promptGuard.blockedBy, instanceId, respondAgent()), code: PROMPT_WAITING_CODE },
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
    //
    // Issue #3945: the send waits its turn for the instance's composer (the
    // input lock in the shared sender) and re-reads the pane once it has it. A
    // dialog found then is the refusal above, found late — the same 409.
    try {
      await cliTool.sendMessage(id, command, instanceId);
    } catch (error) {
      if (classifySendFailure(error).reason === 'prompt-waiting') {
        logger.info('terminal-send-refused-prompt-waiting-under-lock', { worktreeId: id, cliToolId: target.cliToolId });
        return NextResponse.json(
          { error: promptWaitingMessage(id, undefined, instanceId, respondAgent()), code: PROMPT_WAITING_CODE },
          { status: 409 }
        );
      }
      // Issue #4063: Command Code's plan review refused before any key, and
      // its guidance (`respond … "<text>"`, then `--plan-review …`) is the one
      // way out — the fixed 500 below threw it away. 409 like PROMPT_WAITING:
      // a state of the session, not a server fault. The sentence is rebuilt
      // here (still no internal detail passed through, D1-007) with the
      // `respond` aimed by the same rule as the refusal above.
      if (classifySendFailure(error).reason === 'plan-review') {
        logger.info('terminal-send-refused-plan-review', { worktreeId: id, cliToolId: target.cliToolId });
        return NextResponse.json(
          {
            error: commandCodePlanReviewSendMessage(id, instanceId, planReviewRespondAgent()),
            code: PLAN_REVIEW_SEND_REFUSED_CODE,
          },
          { status: 409 }
        );
      }
      throw error;
    }

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
