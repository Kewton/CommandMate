/**
 * POST /api/worktrees/:id/send — starting the session a send needs, and the
 * answers for a start that did not come up (split out of `handleSend` by
 * Issue #4055).
 */

import { NextResponse } from 'next/server';
import type Database from 'better-sqlite3';
import { saveInitialBranch, getInitialBranch } from '@/lib/db';
import type { CLIToolType, ICLITool } from '@/lib/cli-tools/types';
import type { SendAttemptReason } from '@/lib/session/send-attempt-types';
import {
  buildSessionExitedToShellMessage,
  isSessionStartTimeoutError,
  isSessionStartUnavailableError,
  SESSION_STARTING_CODE,
  SESSION_START_FAILED_CODE,
  SESSION_START_UNAVAILABLE_CODE,
} from '@/lib/session/session-start-error';
import {
  isSessionLaunchInFlight,
  isSessionLaunchModelMismatchError,
} from '@/lib/session/session-launch-flight';
import { isPaneBackAtShell } from './pane-shell';
import { getGitStatus } from '@/lib/git/git-utils';
import { createLogger } from '@/lib/logger';
import { AntigravityTool } from '@/lib/cli-tools/antigravity';
import type { ClaudeTool } from '@/lib/cli-tools/claude';
import { broadcastSessionStatus } from '@/lib/realtime/terminal-broadcast';
import type { SendStep } from './send-request';

const logger = createLogger('api/send');

/**
 * Extract error message from unknown error type
 */
function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * The 400 for a `model` sent to a session that is already running (antigravity
 * and claude fix the model at launch); null when the send may go on.
 */
export function refuseModelOnRunningSession(
  model: string | undefined,
  cliToolId: CLIToolType,
  running: boolean,
): NextResponse | null {
  // Issue #989: Antigravity has no in-session model-switch command (unlike
  // Copilot's /model), so --model can only be honored when starting a new
  // session. Reject rather than silently ignoring the requested model.
  if (model && cliToolId === 'antigravity' && running) {
    return NextResponse.json(
      { error: 'Antigravity model can only be set when starting a new session. Stop the current Antigravity session and resend with --model to switch models.' },
      { status: 400 }
    );
  }

  // Issue #2771: the same rule for claude, for the same reason. The model is
  // fixed when the process starts; driving `/model` in a live session is not an
  // option, because Enter on that picker rewrites the operator's global default
  // (#1495 / #2297). A 400 here is what stops a caller believing the model
  // changed when nothing did.
  if (model && cliToolId === 'claude' && running) {
    return NextResponse.json(
      { error: 'Claude model can only be set when starting a new session. Stop the current Claude session and resend with --model to switch models.' },
      { status: 400 }
    );
  }
  return null;
}

/** What {@link startSessionForSend} starts, and where it records a refusal (Issue #4055). */
export interface StartSessionForSendInput {
  db: Database.Database;
  cliTool: ICLITool;
  cliToolId: CLIToolType;
  worktreeId: string;
  worktreePath: string;
  instanceId: string | undefined;
  model: string | undefined;
  /** Records this request's attempt as not sent (Issue #3759 / #4011). */
  recordNotSent: (reason: SendAttemptReason) => void;
}

/**
 * Start the CLI tool session a send needs (it is not running). ok once it is
 * started and broadcast; otherwise the handler's answer.
 */
export async function startSessionForSend(input: StartSessionForSendInput): Promise<SendStep<void>> {
  const { db, cliTool, cliToolId, worktreeId: id, worktreePath, instanceId, model } = input;
  try {
    if (cliToolId === 'antigravity' && model) {
      const antigravityTool = cliTool as AntigravityTool;
      await antigravityTool.startSession(id, worktreePath, instanceId, model);
    } else if (cliToolId === 'claude' && model) {
      // Issue #2771: `ICLITool.startSession` has no model parameter; the
      // concrete class does (via `BaseCLITool`), exactly as antigravity's.
      const claudeTool = cliTool as ClaudeTool;
      await claudeTool.startSession(id, worktreePath, instanceId, model);
    } else {
      await cliTool.startSession(id, worktreePath, instanceId);
    }

    // Issue #111: Save initial branch at session start
    // Get current branch and save it if not already recorded
    const existingInitialBranch = getInitialBranch(db, id);
    if (existingInitialBranch === null) {
      try {
        const gitStatus = await getGitStatus(worktreePath, null);
        if (gitStatus.currentBranch !== '(unknown)' && gitStatus.currentBranch !== '(detached HEAD)') {
          saveInitialBranch(db, id, gitStatus.currentBranch);
          logger.info('saved-initial-branch-for:');
        }
      } catch (gitError) {
        // Log but don't fail - git status is non-critical
        logger.error('failed-to-getsave-initial-branch:', { error: gitError instanceof Error ? gitError.message : String(gitError) });
      }
    }
  } catch (error: unknown) {
    return { ok: false, response: answerSessionStartFailure(error, input) };
  }

  // Issue #1120: push the running transition so sidebar status dots flip
  // immediately instead of waiting for the next /api/worktrees poll.
  broadcastSessionStatus(id, true, { cliTool: cliToolId, instance: instanceId ?? null });
  return { ok: true, value: undefined };
}

/**
 * The answer for a session start that threw (Issue #4055: the start's `catch`).
 * A timeout's answer is returned unawaited, as the handler returned it.
 */
export function answerSessionStartFailure(
  error: unknown,
  input: Pick<StartSessionForSendInput, 'cliTool' | 'worktreeId' | 'instanceId' | 'recordNotSent'>,
): NextResponse | Promise<NextResponse> {
  const { cliTool, worktreeId: id, instanceId, recordNotSent } = input;
  // Review P3-2: this start asked for a model, and joined a launch of the
  // session that is starting with another. Nothing was typed; answered as
  // a `--model` to a running session is (#989 / #2771).
  if (isSessionLaunchModelMismatchError(error)) {
    return NextResponse.json({ error: error.message }, { status: 400 });
  }
  logger.error('failed-to-start-session:', { error: error instanceof Error ? error.message : String(error) });
  recordNotSent(isSessionStartTimeoutError(error) ? 'session-starting' : 'session-start-failed');
  // Issue #1637: a session that is still initializing is not a server
  // fault. The tmux session and the CLI process exist and are coming up,
  // so the honest answer is "temporarily unavailable, retry" — 503 with a
  // stable code — and the message says exactly that. Returning 500 here
  // is what made four separate orchestration runs misdiagnose a slow cold
  // start as a session-creation race.
  if (isSessionStartTimeoutError(error)) {
    return answerSessionStartTimeout(error.message, cliTool, id, instanceId);
  }
  // Issue #2009: the CLI is not installed. Also a 503 — the request was
  // well formed and the server is healthy, the machine is simply missing
  // the binary — and the message is the tool's own, which is authored text
  // (a name plus, for copilot, a fixed install hint), never captured
  // output. `BaseCLITool.startSession` has already reported it.
  if (isSessionStartUnavailableError(error)) {
    return NextResponse.json(
      { error: error.message, code: SESSION_START_UNAVAILABLE_CODE },
      { status: 503 }
    );
  }
  return NextResponse.json(
    { error: `Failed to start ${cliTool.name} session: ${getErrorMessage(error)}` },
    { status: 500 }
  );
}

/**
 * The 503 for a session that did not reach its input prompt (Issue #1637), with
 * the pane checked first (Issue #3093).
 *
 * The timeout's own message says the process is still running. When the pane's
 * bottom row is a shell prompt, the agent has already exited (a startup dialog
 * answered with exit, a crash) and that sentence sends the reader off to wait
 * for nothing — so the answer becomes SESSION_START_FAILED with a message that
 * says the agent exited. A pane that cannot be read keeps the original answer.
 */
export async function answerSessionStartTimeout(
  message: string,
  cliTool: ICLITool,
  worktreeId: string,
  instanceId: string | undefined
): Promise<NextResponse> {
  // Issue #3981: while another request's launch of this session is still in
  // progress (a send that held the input lock is refused rather than made to
  // wait for it), the pane sits at the shell because the launch line has not
  // gone in yet — that is a start in progress, not an agent that exited.
  const launching = isSessionLaunchInFlight(cliTool.getSessionName(worktreeId, instanceId));
  if (!launching && (await isPaneBackAtShell(cliTool, worktreeId, instanceId))) {
    return NextResponse.json(
      {
        error: buildSessionExitedToShellMessage(cliTool.name, cliTool.getSessionName(worktreeId, instanceId)),
        code: SESSION_START_FAILED_CODE,
      },
      { status: 503 }
    );
  }
  return NextResponse.json({ error: message, code: SESSION_STARTING_CODE }, { status: 503 });
}
