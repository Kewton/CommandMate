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
import {
  INSTANCE_INPUT_LOCK_TIMEOUT_CODE,
  INSTANCE_INPUT_OWNERSHIP_LOST_CODE,
  INSTANCE_INPUT_SESSION_REPLACED_CODE,
  withInstanceInputLock,
  type InstanceInputTicket,
} from '@/lib/session/instance-input-lock';
import { readAnswerTargetForeground } from '@/lib/prompt-answer-sender';

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
 * What a strict answer's keys were refused for before they reached the pane
 * (Issue #4303 review), kept by {@link createStrictRespondDeps} for
 * {@link answerStrictlyAsInputWriter}: `strict-respond` counts every throw of
 * `sendKey` as a key that may have gone (exit 41, `send_failed`), and a read
 * that failed as `capture_failed`, so a refusal decided here with nothing typed
 * is told apart by this record, not by the result alone.
 */
export interface StrictAnswerGate {
  /** Set when a check right before a key refused it: that key was not typed. */
  refusedBeforeKey: { refused: 'agent_not_in_foreground' | 'session_replaced'; foreground?: 'shell' | 'unknown' } | null;
  /** The keys this answer handed to tmux and saw come back. */
  keysSent: number;
}

/** A fresh {@link StrictAnswerGate}: nothing refused, no key sent. */
export function newStrictAnswerGate(): StrictAnswerGate {
  return { refusedBeforeKey: null, keysSent: 0 };
}

/**
 * @param ticket - The session's input ticket the answer runs under
 *   ({@link answerStrictlyAsInputWriter}, Issue #3952). Given, a key is sent
 *   only while it is current: a session replaced mid-answer gets none.
 * @param gate - Where a refusal right before a key is recorded (Issue #4303
 *   review); {@link answerStrictlyAsInputWriter} hands one to its answer.
 */
export function createStrictRespondDeps(
  db: Database.Database,
  target: StrictAnswerTarget,
  ticket?: InstanceInputTicket,
  gate: StrictAnswerGate = newStrictAnswerGate()
): StrictRespondDeps {
  const { worktreeId, cliToolId, instanceId, sessionName } = target;
  /**
   * Issue #4303 review: the last read before a key ended with the agent in
   * front and the ticket current. `strict-respond` sends that key with no await
   * in between (the token consumed, the startup gate asked — all synchronous),
   * so the key does not read the foreground again: a refusal thrown by
   * `sendKey` is counted there as a key that may have gone and kept with the
   * operation (exit 41, `send_failed`), which a key never typed is not.
   */
  let confirmedForNextKey = false;
  /**
   * Set once the Enter is handed to tmux: the reads after it are of the
   * outcome, where a shell in front is the agent having exited (#3788) — not a
   * reason to refuse a key, since none is left.
   */
  let enterSent = false;
  /** Refuse with nothing typed: recorded, then thrown for `strict-respond`. */
  const refuseKey = (refused: NonNullable<StrictAnswerGate['refusedBeforeKey']>, why: string): never => {
    gate.refusedBeforeKey = refused;
    throw new Error(why);
  };
  /**
   * The ticket, synchronously: lost, recorded as the refusal. Asked by the
   * startup gate, which `strict-respond` consults right before consuming the
   * token and right before every later key.
   */
  const refusedForTicketNow = (): boolean => {
    if (gate.refusedBeforeKey === null && ticket !== undefined && !ticket.isCurrent()) {
      gate.refusedBeforeKey = { refused: 'session_replaced' };
    }
    return gate.refusedBeforeKey !== null;
  };
  return {
    async read(): Promise<StrictScreenRead> {
      if (!enterSent) confirmedForNextKey = false;
      let payload;
      try {
        // Fresh, and written back to the capture cache at the width the payload
        // builder reads, so the payload below is of this capture.
        await captureSessionOutputFresh(worktreeId, cliToolId, STATUS_CAPTURE_LINES, instanceId);
        payload = await buildCurrentOutput(db, worktreeId, cliToolId, instanceId);
      } catch (error) {
        return { ok: false, stage: 'capture', error: describeError(error) };
      }
      let read: StrictScreenRead;
      try {
        const observation = observeSession(
          worktreeId,
          { cliToolId, instanceId, resolvedBy: target.resolvedBy },
          payload
        );
        read = { ok: true, observation, frame: payload.fullOutput ?? '' };
      } catch (error) {
        return { ok: false, stage: 'observation', error: describeError(error) };
      }
      // Issue #4303 review: a read before a key — the last await before the
      // token is consumed, or before a later key — ends by asking who holds the
      // pane, and then whether the ticket is still current (that read awaits).
      // Refused before the first key, the answer stops as a failed read:
      // nothing typed, the token unspent, the operation not kept. Refused
      // between keys, the read is returned as it was and the startup gate
      // (`startup.isWindowOpen`, asked next) stops the answer with the keys
      // actually sent — the count `strict-respond` keeps with the operation,
      // replays, and returns, so response, record and replay agree.
      if (!enterSent && gate.refusedBeforeKey === null) {
        const foreground = await readAnswerTargetForeground(sessionName);
        if (foreground !== 'other') {
          gate.refusedBeforeKey = { refused: 'agent_not_in_foreground', foreground };
          if (gate.keysSent === 0) {
            return { ok: false, stage: 'capture', error: `agent not in foreground (${foreground}, Issue #4303)` };
          }
          return read;
        }
        if (ticket !== undefined && !ticket.isCurrent()) {
          gate.refusedBeforeKey = { refused: 'session_replaced' };
          if (gate.keysSent === 0) return { ok: false, stage: 'capture', error: 'session replaced (Issue #4303)' };
          return read;
        }
        confirmedForNextKey = true;
      }
      return read;
    },
    sendKey: async key => {
      // Issue #4303: right before each key, the agent must hold the pane — the
      // waits between keys (an arrow sent and then the agent gone must not
      // leave an Enter for the shell). A key right after a read that confirmed
      // it (`confirmedForNextKey`) does not ask again; one sent without such a
      // read asks here, and a refusal is thrown (counted by `strict-respond`,
      // so the gate's reads are the path that keeps the count). Review P1: the
      // ticket is checked after that await, right before the key.
      if (!confirmedForNextKey) {
        const foreground = await readAnswerTargetForeground(sessionName);
        if (foreground !== 'other') {
          refuseKey(
            { refused: 'agent_not_in_foreground', foreground },
            `The agent does not hold session ${sessionName} (${foreground}); no key was sent (Issue #4303)`
          );
        }
      }
      confirmedForNextKey = false;
      if (ticket !== undefined && !ticket.isCurrent()) {
        refuseKey(
          { refused: 'session_replaced' },
          `Session ${sessionName} was replaced while the strict answer held its input (Issue #3952); no key was sent`
        );
      }
      if (key === 'Enter') enterSent = true;
      await sendSessionAnswerKey(worktreeId, cliToolId, key, instanceId);
      gate.keysSent++;
    },
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: () => Date.now(),
    autoYesActive: () => getAutoYesState(worktreeId, cliToolId, instanceId)?.enabled === true,
    // Issue #3788: a shell in front after the Enter is agy having exited.
    paneCommand: () => readSessionPaneCommand(worktreeId, cliToolId, instanceId),
    startup: {
      // Issue #4303 review: also the stop for a refusal recorded by a read or
      // a ticket lost since — `strict-respond` asks this synchronously right
      // before the token is consumed (a refusal there: exit 40, token unspent,
      // operation not kept) and right before each later key (exit 41 with the
      // keys actually sent, `screen_moved_mid_send`).
      isWindowOpen: () => refusedForTicketNow() || isStartupWindowOpen(sessionName),
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

/** Why the session's input lock did not admit a strict answer (Issue #3952). */
export interface StrictInputLockRefusal {
  /**
   * `agent_not_in_foreground` (Issue #4303): admitted, but the pane's own shell
   * holds its terminal (`shell`) or who holds it could not be read (`unknown`).
   */
  refused: 'input_lock_timeout' | 'session_replaced' | 'input_lock_lost' | 'agent_not_in_foreground';
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
  answer: (ticket: InstanceInputTicket, gate: StrictAnswerGate) => Promise<StrictRespondResult>
): Promise<StrictRespondResult | StrictInputLockRefusal> {
  let admitted = false;
  const gate = newStrictAnswerGate();
  let outcome: StrictRespondResult | { notInForeground: 'shell' | 'unknown' } | { replaced: true };
  try {
    outcome = await withInstanceInputLock(
      sessionName,
      async ticket => {
        admitted = true;
        // Issue #4303: before the answer's first read and key, the agent must
        // hold the pane: on `shell` / `unknown` (a reader that threw included)
        // nothing is read or sent and the token is not consumed, so the same
        // answer may be sent again. Review P1: the ticket, again after that await.
        const foreground = await readAnswerTargetForeground(sessionName);
        if (foreground !== 'other') return { notInForeground: foreground };
        if (!ticket.isCurrent()) return { replaced: true as const };
        return answer(ticket, gate);
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
  if ('notInForeground' in outcome) return notInForegroundRefusal(sessionName, outcome.notInForeground);
  if ('replaced' in outcome) return replacedRefusal(sessionName);
  return settleRefusalBeforeKey(sessionName, outcome, gate);
}

function notInForegroundRefusal(sessionName: string, foreground: 'shell' | 'unknown'): StrictInputLockRefusal {
  logger.info('strict-prompt-response-agent-not-in-foreground', { sessionName, foreground });
  return {
    refused: 'agent_not_in_foreground',
    message:
      foreground === 'shell'
        ? `Nothing was sent: the agent in session ${sessionName} is not running — the pane is back at its shell (Issue #4303).`
        : `Nothing was sent: who holds session ${sessionName} could not be read (Issue #4303). Send it again.`,
  };
}

function replacedRefusal(sessionName: string): StrictInputLockRefusal {
  logger.info('strict-prompt-response-input-lock-refused', { sessionName, refused: 'session_replaced' });
  return {
    refused: 'session_replaced',
    message: `Nothing was sent: session ${sessionName} was replaced while the strict answer waited (Issue #4303).`,
  };
}

/**
 * The answer's result, told apart from a refusal right before a key (Issue
 * #4303 review P2): `strict-respond` reads that refusal as a failed read
 * (exit 40, `capture_failed`) or a key that may have gone (exit 41,
 * `send_failed`, counted). With no key typed it is the refusal it was —
 * nothing sent, so no `prompt_answered_human` row and the CLI's exit 40. With
 * keys typed before it, the result stands with the keys actually sent.
 *
 * Re-instruction 2: `strict-respond` keeps its result with the operation before
 * this runs, so the deps stop a refused answer where that result already
 * carries the right count — a refused read before the token (exit 40, the
 * operation not kept) or the startup gate between keys (exit 41, the keys
 * actually sent). The correction below is then a no-op; it stays for a key
 * refused by `sendKey` itself, which no read confirmed.
 */
function settleRefusalBeforeKey(
  sessionName: string,
  result: StrictRespondResult,
  gate: StrictAnswerGate
): StrictRespondResult | StrictInputLockRefusal {
  const refusal = gate.refusedBeforeKey;
  if (refusal === null || result.replayed) return result;
  if (gate.keysSent === 0) {
    return refusal.refused === 'agent_not_in_foreground'
      ? notInForegroundRefusal(sessionName, refusal.foreground ?? 'unknown')
      : replacedRefusal(sessionName);
  }
  return { ...result, keysSent: gate.keysSent };
}
