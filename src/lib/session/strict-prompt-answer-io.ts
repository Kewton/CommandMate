/**
 * The I/O of the strict `respond` (Issue #3756): what
 * `POST /api/worktrees/:id/prompt-response/strict` hands
 * `lib/prompt-observation/strict-respond`, and the record it leaves.
 *
 * A read is the observation `GET current-output?observe=1` makes — the same
 * payload builder and the same `observeSession` — of a capture taken fresh for
 * it, so a token issued by one is verified against a binding built exactly the
 * way it was issued.
 *
 * @module lib/session/strict-prompt-answer-io
 */

import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { captureSessionOutputFresh, readSessionPaneCommand, sendSessionAnswerKey } from '@/lib/session/cli-session';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { observeSession } from '@/lib/prompt-observation/session';
import type { StrictRespondDeps, StrictScreenRead } from '@/lib/prompt-observation/strict-respond';
import type { StrictRespondResult } from '@/lib/prompt-observation/types';
import {
  forgetStartupTrust,
  holdStartupTrust,
  isStartupWindowOpen,
  wasStartupTrustClaimedWithin,
} from '@/lib/cli-tools/antigravity-startup-trust';
import { applyEventToActiveTask } from '@/lib/tasks/task-transition-service';
import { getAutoYesState } from '@/lib/auto-yes-state';

const logger = createLogger('api/prompt-response-strict');

/** The session a strict answer addresses. */
export interface StrictAnswerTarget {
  worktreeId: string;
  cliToolId: CLIToolType;
  /** Undefined for the primary instance. */
  instanceId: string | undefined;
  sessionName: string;
  resolvedBy: string | null;
}

/** The most of an error's message that is logged: a screen's text may be in it. */
const LOGGED_MESSAGE_CHARS = 80;

/**
 * An error as it may be logged or returned: its name, its `code` and the first
 * {@link LOGGED_MESSAGE_CHARS} characters of its message — never the whole
 * message, which can carry the pane's text (Issue #3771).
 */
export function describeError(error: unknown): string {
  const name = error instanceof Error ? error.name : typeof error;
  const rawCode = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
  const code = typeof rawCode === 'string' || typeof rawCode === 'number' ? ` code=${rawCode}` : '';
  const message = (error instanceof Error ? error.message : String(error)).replace(/\s+/g, ' ');
  return `${name}${code}: ${message.slice(0, LOGGED_MESSAGE_CHARS)}`;
}

export function createStrictRespondDeps(db: Database.Database, target: StrictAnswerTarget): StrictRespondDeps {
  const { worktreeId, cliToolId, instanceId, sessionName } = target;
  return {
    async read(): Promise<StrictScreenRead> {
      let payload;
      try {
        // Fresh, and written back to the capture cache at the width the payload
        // builder reads, so the payload below is of this capture.
        await captureSessionOutputFresh(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
        payload = await buildCurrentOutput(db, worktreeId, cliToolId, instanceId);
      } catch (error) {
        return { ok: false, stage: 'capture', error: describeError(error) };
      }
      try {
        const observation = observeSession(
          worktreeId,
          { cliToolId, instanceId, resolvedBy: target.resolvedBy },
          payload
        );
        return { ok: true, observation, frame: payload.fullOutput ?? '' };
      } catch (error) {
        return { ok: false, stage: 'observation', error: describeError(error) };
      }
    },
    sendKey: key => sendSessionAnswerKey(worktreeId, cliToolId, key, instanceId),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    autoYesActive: () => getAutoYesState(worktreeId, cliToolId, instanceId)?.enabled === true,
    // Issue #3788: a shell in front after the Enter is agy having exited.
    paneCommand: () => readSessionPaneCommand(worktreeId, cliToolId, instanceId),
    startup: {
      isWindowOpen: () => isStartupWindowOpen(sessionName),
      claimedWithin: ms => wasStartupTrustClaimedWithin(sessionName, ms),
      hold: () => holdStartupTrust(sessionName),
      discardDebt: () => forgetStartupTrust(sessionName),
    },
  };
}

/**
 * Who answered, what screen, and with what: one `server.log` line for every
 * verdict, and a `prompt_answered_human` row in the task's history once any
 * key was sent — an answer cut short (exit 41 before the Enter, or after it
 * with no outcome read) is recorded with its reason code. The screen's text is not logged; its kind, folder and the
 * chosen label are.
 *
 * @param answeredBy - Who the CLI says it runs as (`cli`, or `agent:<worktree>/<instance>`)
 */
export function recordStrictAnswer(
  db: Database.Database,
  target: StrictAnswerTarget,
  result: StrictRespondResult,
  answeredBy: string
): void {
  const instanceId = target.instanceId ?? target.cliToolId;
  const fields = {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId,
    answeredBy,
    operationId: result.operationId,
    code: result.code,
    delivery: result.delivery,
    reason: result.reason,
    expectedKind: result.expectedKind,
    observedKind: result.observedKind,
    approvalTarget: result.observedTarget,
    option: result.answer,
    keysSent: result.keysSent,
    outcome: result.outcome,
    replayed: result.replayed,
  };
  if (result.code === 40) {
    logger.info('strict-prompt-response-refused', fields);
    return;
  }
  logger.info('strict-prompt-answered', fields);
  if (result.replayed || result.keysSent === 0) return;

  const what = result.answer === null ? 'an unresolved option' : `option ${result.answer.position} "${result.answer.label}"`;
  const folder = result.observedTarget === null ? '' : ` folder=${result.observedTarget}`;
  const ending = result.reason === null ? `outcome ${result.outcome}` : `stopped: ${result.reason}, ${result.keysSent} key(s) sent`;
  try {
    applyEventToActiveTask(db, target.worktreeId, target.cliToolId, instanceId, 'prompt_answered_human', {
      promptType: result.expectedKind,
      answeredBy,
      ...(result.answer === null ? {} : { option: `${result.answer.position}. ${result.answer.label}` }),
      reason: `strict respond by ${answeredBy}: ${what}${folder} (operation ${result.operationId}, ${ending})`,
    });
  } catch (error) {
    logger.warn('strict-prompt-answer-record-failed', { error: describeError(error) });
  }
}
