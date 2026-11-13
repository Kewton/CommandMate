/**
 * The end of a hand-off: the stop declared, and afterwards what was seen of it
 * (Issue #4227, design `mem-ui-4227.md` §4.6, 6th edition: the hand-off never kills).
 *
 * The person's stop button does three things in its handler, in this order: `end` (the
 * declaration, here), the existing stop (the screen's `killSession` → the kill-session
 * route, unchanged), and `end/observe` (here). Neither function here stops a session:
 * the observation is given whether the instance runs (`cliTool.isRunning`, read by the
 * route) as a value, and is judged with the request's conversation:
 *
 * - the conversation changed (a restart after the stop) → `ended`,
 *   `unconfirmed(session_changed)`, whatever runs (nothing is done to it);
 * - still running, or the read failed → back to `reviewing`, 409 `not_stopped`;
 * - stopped → `ended`, the outcome in this order: forced (always, §0.1 G5) →
 *   the agent's `done` (`agent_timeout`, or `request_failed` when the text never went) →
 *   undecided proposals (`undecided_left`) → conflicts (`conflict_left`) → failures
 *   (`apply_failed`) → `confirmed`.
 *
 * Once forced, forced for good (`MAX(end_forced, ?)`, the v71 trigger).
 *
 * @module lib/handoff/end
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  changeHandoffRequest,
  getHandoffRequest,
  HANDOFF_OPEN_STATES,
  listHandoffProposals,
  raiseEndForced,
  settleUndecidedProposals,
  type HandoffRequestRow,
} from '@/lib/db/handoff-db';
import { isScreenRequest } from '@/lib/security/screen-request';
import {
  closedRefusal,
  handoffError,
  invalidRequest,
  isVersion,
  judgeRequest,
  nowOf,
  readView,
  requestOf,
  sameConversation,
  type HandoffDeps,
  type HandoffOutcome,
} from './common';
import type { HandoffEndResponse } from './types';

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

/**
 * `POST …/requests/:rid/end` `{ ifVersion, force? }`: the stop declared. Taken from
 * `awaiting_agent` and `reviewing`, and from `applying` with `force` (the decide's
 * remaining writes stop at their fence: the token is taken away). With `force` the
 * undecided proposals are `discarded(forced)`. Whatever the mode is. Kills nothing.
 */
export function handoffEnd(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
): HandoffOutcome {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  if (!isVersion(body.ifVersion)) return invalidRequest('ifVersion');
  if (body.force !== undefined && typeof body.force !== 'boolean') return invalidRequest('force');
  const ifVersion = body.ifVersion;
  const force = body.force === true;
  const now = nowOf(deps);
  return db.transaction((): HandoffOutcome => {
    const found = requestOf(db, worktreeId, requestId);
    if (!found) return handoffError('not_found');
    const row = judgeRequest(db, found, now);
    if (!HANDOFF_OPEN_STATES.includes(row.state)) return closedRefusal(db, row, now);
    if (row.version !== ifVersion) return handoffError('version_conflict', { ...readView(db, row, now) });
    if (row.state === 'applying' && !force) return handoffError('state_forbids', { request: readView(db, row, now).request });
    const endToken = randomUUID();
    changeHandoffRequest(db, row.id, ifVersion, { state: 'ending', endToken, applyToken: null }, now);
    raiseEndForced(db, row.id, force);
    if (force) settleUndecidedProposals(db, row.id, { state: 'discarded', reason: 'forced' }, now);
    const answer: HandoffEndResponse = { ...readView(db, getHandoffRequest(db, row.id)!, now), endToken };
    return { status: 200, body: answer };
  })();
}

/** The first of the conditions of `confirmed` that is missing (§0.1 G5), or null. */
function missingCondition(db: Database.Database, row: HandoffRequestRow): string | null {
  if (row.agentDoneAt === null) return row.sendState === 'failed' ? 'request_failed' : 'agent_timeout';
  const states = listHandoffProposals(db, row.id).map((proposal) => proposal.state);
  if (states.some((state) => state === 'proposed' || state === 'approved')) return 'undecided_left';
  if (states.includes('conflict')) return 'conflict_left';
  if (states.includes('failed')) return 'apply_failed';
  return null;
}

/**
 * `POST …/requests/:rid/end/observe` `{ endToken }`, with what the route read: `running`
 * is `cliTool.isRunning(target_worktree_id, instance_id)` (true / false), or null when
 * the read failed. Records how the session ended; kills nothing.
 */
export function handoffObserve(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  observed: { running: boolean | null },
  deps: HandoffDeps = {}
): HandoffOutcome {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  if (typeof body.endToken !== 'string' || body.endToken.length === 0) return invalidRequest('endToken');
  const endToken = body.endToken;
  const now = nowOf(deps);
  return db.transaction((): HandoffOutcome => {
    const found = requestOf(db, worktreeId, requestId);
    if (!found) return handoffError('not_found');
    const row = judgeRequest(db, found, now);
    if (row.endToken !== endToken) return handoffError('end_token_changed', { ...readView(db, row, now) });
    if (row.state === 'ended') return handoffError('already_recorded', { ...readView(db, row, now) });
    if (row.state !== 'ending') return closedRefusal(db, row, now);

    const end = (outcome: 'confirmed' | 'unconfirmed', reason: string | null): HandoffOutcome => {
      changeHandoffRequest(db, row.id, null, { state: 'ended', endedAt: now, outcome, outcomeReason: reason }, now);
      settleUndecidedProposals(db, row.id, { state: 'expired', reason: reason ?? 'ended' }, now);
      return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
    };
    // The conversation is compared first: after a restart nothing said about what runs is about this one.
    if (!sameConversation(db, row)) return end('unconfirmed', row.endForced ? 'forced' : 'session_changed');
    if (observed.running !== false) {
      changeHandoffRequest(db, row.id, null, { state: 'reviewing', endToken: null }, now);
      return handoffError('not_stopped', { ...readView(db, getHandoffRequest(db, row.id)!, now) });
    }
    if (row.endForced) return end('unconfirmed', 'forced');
    const missing = missingCondition(db, row);
    return missing === null ? end('confirmed', null) : end('unconfirmed', missing);
  })();
}
