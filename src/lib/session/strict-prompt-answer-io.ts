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
import { captureSessionOutputFresh, sendSessionAnswerKey } from '@/lib/session/cli-session';
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
        return { ok: false, stage: 'capture', error: messageOf(error) };
      }
      try {
        const observation = observeSession(
          worktreeId,
          { cliToolId, instanceId, resolvedBy: target.resolvedBy },
          payload
        );
        return { ok: true, observation, frame: payload.fullOutput ?? '' };
      } catch (error) {
        return { ok: false, stage: 'observation', error: messageOf(error) };
      }
    },
    sendKey: key => sendSessionAnswerKey(worktreeId, cliToolId, key, instanceId),
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
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
 * verdict, and a `prompt_answered_human` row in the task's history once the
 * Enter was sent. The screen's text is not logged; its kind, folder and the
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
  if (result.replayed || result.outcome === null || result.answer === null) return;

  const what = `option ${result.answer.position} "${result.answer.label}"`;
  const folder = result.observedTarget === null ? '' : ` folder=${result.observedTarget}`;
  try {
    applyEventToActiveTask(db, target.worktreeId, target.cliToolId, instanceId, 'prompt_answered_human', {
      promptType: result.expectedKind,
      reason: `strict respond by ${answeredBy}: ${what}${folder} (operation ${result.operationId}, outcome ${result.outcome})`,
    });
  } catch (error) {
    logger.warn('strict-prompt-answer-record-failed', { error: messageOf(error) });
  }
}
