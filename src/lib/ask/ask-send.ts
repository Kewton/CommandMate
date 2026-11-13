/**
 * The send route's side of an ask (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.2・§4): whether this send carries an
 * envelope, the reservation before anything is typed, and the send's outcome
 * after it.
 *
 * Kept apart from the route so the route only orders the steps: plan (before
 * any side effect), deliver with `askEnvelopeId`, settle (after the answer).
 */

import type Database from 'better-sqlite3';
import {
  getAskCorrelation,
  pruneAskCorrelations,
  recordAskSendOutcome,
  reserveAsk,
} from '@/lib/db/ask-correlation-db';
import { createLogger } from '@/lib/logger';
import type { AskSendAnswer, AskSendState } from '@/types/ask-correlation';
import { askBodyDigest, isAskCommandBody, supportsAskAttribution } from './ask-correlation';

const logger = createLogger('lib/ask/ask-send');

/** What {@link planAskForSend} decided. */
export type AskSendPlan =
  /** No `ask` on the body: the send is as it always was. */
  | { kind: 'none' }
  /** Not attributed (tool, command body): sent as without the field, the answer says why. */
  | { kind: 'unavailable'; answer: AskSendAnswer }
  /** Reserved: the typed text carries the envelope of `askId`. */
  | { kind: 'reserved'; askId: string; answer: AskSendAnswer }
  /** The same askId again: nothing is typed (200 with the row's state, or 409 for another body). */
  | { kind: 'answered'; status: 200 | 409; body: Record<string, unknown> };

/**
 * Decide and, when attributed, reserve (§4 `reserveAsk`). Before any side
 * effect of the send; a database failure throws (the route answers 500 and
 * types nothing).
 */
export function planAskForSend(
  db: Database.Database,
  ask: { id: string } | undefined,
  target: { worktreeId: string; cliToolId: string; instanceId: string; content: string },
): AskSendPlan {
  if (!ask) return { kind: 'none' };
  if (!supportsAskAttribution(target.cliToolId)) {
    return { kind: 'unavailable', answer: { id: null, state: 'unavailable', reason: 'tool_unsupported' } };
  }
  // M4: a command is typed as it is — an envelope in front would make it text.
  if (isAskCommandBody(target.content)) {
    return { kind: 'unavailable', answer: { id: null, state: 'unavailable', reason: 'slash_command' } };
  }
  const reserved = reserveAsk(db, {
    askId: ask.id,
    worktreeId: target.worktreeId,
    instanceId: target.instanceId,
    cliToolId: target.cliToolId,
    bodyDigest: askBodyDigest(target.content),
  });
  if (reserved.kind === 'conflict') {
    return {
      kind: 'answered',
      status: 409,
      body: { error: 'ask id is already reserved for another message', code: 'ASK_ID_CONFLICT' },
    };
  }
  if (reserved.kind === 'existing') {
    const { row } = reserved;
    return {
      kind: 'answered',
      status: 200,
      body: { ask: { id: row.askId, state: row.attributionState, reason: row.reason, sendState: row.sendState } },
    };
  }
  try {
    pruneAskCorrelations(db, target.worktreeId);
  } catch (error) {
    logger.warn('ask-correlation-prune-failed', { error: error instanceof Error ? error.message : String(error) });
  }
  return {
    kind: 'reserved',
    askId: ask.id,
    answer: { id: ask.id, state: 'pending', reason: null, sendState: 'reserved' },
  };
}

/**
 * Record how a reserved ask's send ended (§4 `recordSendOutcome`), after the
 * input. Never throws: the send already happened, and its answer must not turn
 * into a failure because the ledger could not be written.
 *
 * @returns The send state written (for the answer), or null when nothing was
 */
export function settleAskSend(
  db: Database.Database,
  askId: string,
  outcome: { sendState: Exclude<AskSendState, 'reserved'>; sentMessageId?: string | null; turnOpenAtSend?: boolean | null },
): AskSendState | null {
  try {
    recordAskSendOutcome(db, askId, outcome);
    return getAskCorrelation(db, askId)?.sendState ?? null;
  } catch (error) {
    logger.warn('ask-correlation-send-outcome-failed', { askId, error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}
