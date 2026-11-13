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
 * Issue #4304 F1-a (design §4.4 R7 strict / R11-c): that capture is a
 * `BoundFrame`, and the payload, the observation and the frame are all built
 * from it (`buildCurrentOutput`'s `boundFrame`) — no longer from the display
 * cache a `captureSessionOutputFresh` write-back used to fill. The first read
 * fixes the pane generation G of the answer; every later read is of G only, and
 * every key goes to G or is not sent.
 *
 * @module lib/session/strict-prompt-answer-io
 */

import type Database from 'better-sqlite3';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { createLogger } from '@/lib/logger';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import {
  captureBoundFrame,
  checkPaneGeneration,
  readSessionPaneCommand,
  sendSessionAnswerKey,
} from '@/lib/session/cli-session';
import {
  applyWhilePaneIsCurrent,
  paneAnswerContextOf,
  type PaneAnswerContext,
} from '@/lib/session/pane-answer-context';
import { StrictKeyNotSentError } from '@/lib/prompt-observation/strict-key-delivery';
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
import {
  INSTANCE_INPUT_LOCK_TIMEOUT_CODE,
  INSTANCE_INPUT_OWNERSHIP_LOST_CODE,
  INSTANCE_INPUT_SESSION_REPLACED_CODE,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';

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

/**
 * The session I/O of a strict answer: what `respondStrictly` reads and sends
 * with, and the pane the answer's first read was of.
 */
export interface StrictRespondSessionDeps extends StrictRespondDeps {
  /**
   * The pane the answer's first read was of (Issue #4304 F1-a), as the context
   * {@link settleStrictAnswer} acts on the current state with; `never-read`
   * when no read bound one (then no key was sent either).
   */
  answerPane(): StrictAnswerPane;
}

/** The pane a strict answer was decided for (Issue #4304 F1-a). */
export type StrictAnswerPane =
  | { readonly kind: 'pane'; readonly context: PaneAnswerContext }
  | { readonly kind: 'never-read' };

/**
 * @param ticket - The session's input ticket the answer runs under
 *   ({@link answerStrictlyAsInputWriter}, Issue #3952). Given, a key is sent
 *   only while it is current: a session replaced mid-answer gets none.
 */
export function createStrictRespondDeps(
  db: Database.Database,
  target: StrictAnswerTarget,
  ticket?: InstanceInputTicket
): StrictRespondSessionDeps {
  const { worktreeId, cliToolId, instanceId, sessionName } = target;
  // Issue #4304 F1-a: the pane this answer's first read was of — the frame it
  // was decided on fixes it, and every later read and key is of it only.
  let context: PaneAnswerContext | null = null;
  return {
    async read(): Promise<StrictScreenRead> {
      let payload;
      try {
        // Issue #4304 F1-a: bound to its pane generation (G after the first
        // read), and the payload below is built from this very frame.
        const bound = await captureBoundFrame(
          { worktreeId, cliToolId, instanceId },
          { lines: STATUS_CAPTURE_LINES, ...(context !== null ? { expected: context.generation } : {}) },
        );
        if (bound.kind === 'unknown') {
          return { ok: false, stage: 'capture', error: `pane generation unconfirmed: ${bound.reason} (Issue #4304)` };
        }
        context ??= paneAnswerContextOf(bound, sessionName);
        payload = await buildCurrentOutput(db, worktreeId, cliToolId, instanceId, undefined, { boundFrame: bound });
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
    // Issue #4304 F1-a (§3.3-1): every refusal before the key is the same
    // `StrictKeyNotSentError` — the ticket's before and after the pane look,
    // the pane look itself, and a key asked for before any read fixed the pane
    // (there is no pane to send it to: it is refused, not bound to the pane as
    // it is now). Only `sendSessionAnswerKey` throwing is a key that may have gone.
    sendKey: async key => {
      if (ticket !== undefined && !ticket.isCurrent()) throw new StrictKeyNotSentError(sessionName, 'input-ticket-lost');
      if (context === null) throw new StrictKeyNotSentError(sessionName, 'no-read');
      let check;
      try {
        check = await checkPaneGeneration(sessionName, context.generation);
      } catch {
        check = 'generation-unreadable' as const;
      }
      if (check !== 'same') throw new StrictKeyNotSentError(sessionName, check);
      if (ticket !== undefined && !ticket.isCurrent()) throw new StrictKeyNotSentError(sessionName, 'input-ticket-lost');
      await sendSessionAnswerKey(worktreeId, cliToolId, key, instanceId);
    },
    answerPane: () => (context === null ? { kind: 'never-read' } : { kind: 'pane', context }),
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

/**
 * What a strict answer leaves once it is done (Issue #4304 F1-a, §3.3-3 / -5).
 *
 * A refusal, a replayed operation and an answer with no key sent leave the
 * server.log line only ({@link recordStrictAnswer}), as before. An answer whose
 * keys reached the pane its reads were of acts on the instance's current state
 * — the task's `prompt_answered_human` row, the response poll restarted, the
 * terminal pushed (`resume`) — only through {@link applyWhilePaneIsCurrent}:
 * after every await, the session must still show that pane (alive, or dead by
 * the answer: agy's `No, exit`). A pane replaced meanwhile (the session epoch
 * unchanged — an outside `new-window`) gets none of it: the answer's history
 * is the log line, written with `paneMoved`.
 *
 * @param pane - {@link StrictRespondSessionDeps.answerPane}: required, so no
 *   caller can settle an answer without the pane it was decided for
 * @param resume - The route's restart of the response poll and the terminal
 *   push, run synchronously inside the entry
 */
export async function settleStrictAnswer(
  db: Database.Database,
  target: StrictAnswerTarget,
  result: StrictRespondResult,
  answeredBy: string,
  pane: StrictAnswerPane,
  resume: () => undefined,
): Promise<void> {
  if (result.code === 40 || result.replayed || result.keysSent === 0) {
    recordStrictAnswer(db, target, result, answeredBy);
    return;
  }
  // Keys went out, so a read fixed the pane: `never-read` cannot have sent any.
  // Taken as a pane that moved — the history only — should it ever happen.
  const verdict =
    pane.kind === 'pane'
      ? await applyWhilePaneIsCurrent(pane.context, { allowDead: true, owned: () => true }, () => {
          recordStrictAnswer(db, target, result, answeredBy);
          resume();
          return undefined;
        })
      : 'pane-moved';
  if (verdict === 'applied') return;
  logger.info('strict-prompt-answered', {
    worktreeId: target.worktreeId,
    cliToolId: target.cliToolId,
    instanceId: target.instanceId ?? target.cliToolId,
    answeredBy,
    operationId: result.operationId,
    code: result.code,
    delivery: result.delivery,
    reason: result.reason,
    keysSent: result.keysSent,
    outcome: result.outcome,
    replayed: result.replayed,
    paneMoved: true,
  });
}

/** Why the session's input lock did not admit a strict answer (Issue #3952). */
export interface StrictInputLockRefusal {
  refused: 'input_lock_timeout' | 'session_replaced' | 'input_lock_lost';
  message: string;
}

/**
 * Run a strict answer as a `shared` writer of the session's input (Issue
 * #3952): from its first read to its last key no message send or clear types
 * into the pane (other answers are ordered by the strict lock and the startup
 * hold, as before). The answer's own first read is taken after admission, so a
 * screen that moved while it waited for a send is refused by its checks, as any
 * moved screen is. A lock that did not admit it is a refusal with nothing
 * sent, never thrown.
 */
export async function answerStrictlyAsInputWriter(
  sessionName: string,
  answer: (ticket: InstanceInputTicket) => Promise<StrictRespondResult>
): Promise<StrictRespondResult | StrictInputLockRefusal> {
  let admitted = false;
  try {
    return await withInstanceInputLock(
      sessionName,
      ticket => {
        admitted = true;
        return answer(ticket);
      },
      { mode: 'shared' }
    );
  } catch (error) {
    const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined;
    const refused =
      admitted ? null
        : code === INSTANCE_INPUT_LOCK_TIMEOUT_CODE ? 'input_lock_timeout'
          : code === INSTANCE_INPUT_SESSION_REPLACED_CODE ? 'session_replaced'
            : code === INSTANCE_INPUT_OWNERSHIP_LOST_CODE ? 'input_lock_lost'
              : null;
    if (refused === null) throw error;
    logger.info('strict-prompt-response-input-lock-refused', { sessionName, refused });
    return { refused, message: `Nothing was sent: ${error instanceof Error ? error.message : String(error)}` };
  }
}
