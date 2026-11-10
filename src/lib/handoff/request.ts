/**
 * A hand-off request: made by the screen, read by the screen and the CLI, and the
 * screen's small steps on it (Issue #4227, design `mem-ui-4227.md` §4.1・§4.3・§4.4).
 *
 * - `handoffCreate`: the person pressed "end" on a branch set to be attended (`popup`)
 *   with mode `on`. Fixes the branch, the worktree's and the instance's lifetimes and
 *   the conversation (the current D1 boundary). No boundary: 409 `session_unknown`.
 * - `handoffRead`: the request as it is now, with the judgement made when read
 *   (expiry, a changed session): an old request may become `expired` here, nothing else
 *   is written (no item, nothing of a newer conversation).
 * - `handoffSent` / `handoffSendFailed`: what came of the screen's send of the text (②).
 * - `handoffExtend`: 5 more minutes for the agent, twice at most.
 * - `handoffCancel`: the person gave up ending: undecided proposals are discarded; what
 *   was confirmed stays (never rolled back).
 *
 * Every write needs the screen's mark (403 `screen_only`), asked here and in the route.
 * Nothing here kills a session or runs in the background.
 *
 * @module lib/handoff/request
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { getCurrentBoundary, readInstanceLifetime } from '@/lib/db/session-brief-db';
import {
  changeHandoffRequest,
  getHandoffRequest,
  HANDOFF_OPEN_STATES,
  insertHandoffRequest,
  listLiveHandoffRequests,
  purgeOldHandoffRequests,
  settleUndecidedProposals,
} from '@/lib/db/handoff-db';
import { getOrCreateWorktreeIncarnation } from '@/lib/mem/incarnation';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import { isScreenRequest } from '@/lib/security/screen-request';
import { memError } from '@/lib/mem/service';
import {
  closedRefusal,
  handoffError,
  invalidRequest,
  isVersion,
  judgeRequest,
  modeRefusal,
  nowOf,
  readView,
  requestOf,
  sameConversation,
  withBranchMode,
  type HandoffDeps,
  type HandoffOutcome,
} from './common';
import { handoffRequestText } from './template';
import {
  HANDOFF_AGENT_WINDOW_MS,
  HANDOFF_MAX_EXTENSIONS,
  HANDOFF_REQUEST_TTL_MS,
  HANDOFF_RETAIN_MS,
  type HandoffCreateResponse,
} from './types';

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

/** `POST …/handoff/requests` `{ instanceId }`. */
export async function handoffCreate(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
): Promise<HandoffOutcome> {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return memError('not_found');
  if (typeof body.instanceId !== 'string' || body.instanceId.length === 0) return invalidRequest('instanceId');
  const instanceId = body.instanceId;
  const instance = resolveAgentInstances(db, worktreeId, worktree.selectedAgents).find((entry) => entry.id === instanceId);
  if (!instance) return memError('instance_not_found');
  // Fixed before the await: a re-creation while git answers is a different lifetime.
  const worktreeIncarnation = getOrCreateWorktreeIncarnation(db, worktreeId);
  const lifetime = readInstanceLifetime(db, worktreeId, instanceId);

  return withBranchMode(db, worktreeId, undefined, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    if (!target.features.popup) return handoffError('unattended');
    const now = nowOf(deps);
    purgeOldHandoffRequests(db, now - HANDOFF_RETAIN_MS);
    // One live request per instance: an open one, or one whose stop is declared in this same
    // conversation (it may go back to `reviewing`). A declared stop of an older conversation
    // can only end (its observation records session_changed), so it does not hold the place.
    const live = listLiveHandoffRequests(db, worktreeId).filter((entry) => entry.instanceId === instanceId);
    for (const entry of live) {
      const judged = judgeRequest(db, entry, now);
      if (HANDOFF_OPEN_STATES.includes(judged.state) || (judged.state === 'ending' && sameConversation(db, judged))) {
        // pr2e P3-3 (G-PR3): a request picked up again carries its text, so the screen can send
        // it again when it never went (`unsent`: the screen closed while `create` was answered).
        return handoffError('request_open', { ...readView(db, judged, now), text: handoffRequestText(judged.id, new Date(judged.agentDeadlineAt)) });
      }
    }
    const boundary = getCurrentBoundary(db, worktreeId, instanceId);
    if (!boundary) return handoffError('session_unknown');
    const row = insertHandoffRequest(db, {
      id: randomUUID(),
      repositoryId: target.storageRepositoryId,
      branch: target.detached ? null : target.branch,
      detached: target.detached,
      targetWorktreeId: worktreeId,
      targetWorktreeIncarnation: worktreeIncarnation,
      instanceId,
      cliToolId: instance.cliTool,
      instanceIncarnation: lifetime.incarnation,
      instanceOnRoster: lifetime.onRoster,
      boundaryId: boundary.id,
      agentDeadlineAt: now + HANDOFF_AGENT_WINDOW_MS,
      expiresAt: now + HANDOFF_REQUEST_TTL_MS,
      now,
    });
    // The lifetimes fixed before the await are the ones the request keeps: if they moved meanwhile it is already old.
    const judged = judgeRequest(db, row, now);
    if (judged.state !== 'awaiting_agent') return closedRefusal(db, judged, now);
    const answer: HandoffCreateResponse = { ...readView(db, judged, now), text: handoffRequestText(judged.id, new Date(judged.agentDeadlineAt)) };
    return { status: 201, body: answer };
  });
}

/** `GET …/handoff/requests/:rid` (no mark: the screen and the CLI read it). */
export function handoffRead(db: Database.Database, worktreeId: string, requestId: string, deps: HandoffDeps = {}): HandoffOutcome {
  const now = nowOf(deps);
  return db.transaction((): HandoffOutcome => {
    const row = requestOf(db, worktreeId, requestId);
    if (!row) return handoffError('not_found');
    const judged = judgeRequest(db, row, now);
    return { status: 200, body: readView(db, judged, now) };
  })();
}

/** The screen's small steps on an open request that need the branch `on` (sent, send-failed, extend). */
async function screenStep(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  deps: HandoffDeps,
  step: (row: NonNullable<ReturnType<typeof getHandoffRequest>>, now: number) => HandoffOutcome
): Promise<HandoffOutcome> {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  const before = requestOf(db, worktreeId, requestId);
  if (!before) return handoffError('not_found');
  return withBranchMode(db, worktreeId, before.branch, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    const now = nowOf(deps);
    const row = judgeRequest(db, getHandoffRequest(db, requestId)!, now);
    if (!HANDOFF_OPEN_STATES.includes(row.state)) return closedRefusal(db, row, now);
    if (row.endForced) return handoffError('request_closed', { request: readView(db, row, now).request });
    return step(row, now);
  });
}

/** `POST …/requests/:rid/sent`: the text reached the agent's input (②). */
export function handoffSent(db: Database.Database, request: ScreenRequest, worktreeId: string, requestId: string, deps: HandoffDeps = {}) {
  return screenStep(db, request, worktreeId, requestId, deps, (row, now) => {
    if (row.state !== 'awaiting_agent') return handoffError('request_closed');
    changeHandoffRequest(db, row.id, null, { sendState: 'sent' }, now);
    return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
  });
}

/** `POST …/requests/:rid/send-failed`: the text could not be sent; the screen offers a resend. */
export function handoffSendFailed(db: Database.Database, request: ScreenRequest, worktreeId: string, requestId: string, deps: HandoffDeps = {}) {
  return screenStep(db, request, worktreeId, requestId, deps, (row, now) => {
    if (row.state !== 'awaiting_agent') return handoffError('request_closed');
    changeHandoffRequest(db, row.id, null, { sendState: 'failed' }, now);
    return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
  });
}

/** `POST …/requests/:rid/extend` `{ ifVersion }`: 5 more minutes for the agent (twice at most). */
export function handoffExtend(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
) {
  if (!isVersion(body.ifVersion)) return Promise.resolve(invalidRequest('ifVersion'));
  const ifVersion = body.ifVersion;
  return screenStep(db, request, worktreeId, requestId, deps, (row, now) => {
    if (row.version !== ifVersion) return handoffError('version_conflict', { ...readView(db, row, now) });
    if (row.state !== 'awaiting_agent') return handoffError('request_closed');
    if (row.extensions >= HANDOFF_MAX_EXTENSIONS) return handoffError('extend_limit');
    const deadline = Math.max(row.agentDeadlineAt, now) + HANDOFF_AGENT_WINDOW_MS;
    changeHandoffRequest(db, row.id, ifVersion, { agentDeadlineAt: deadline, extensions: row.extensions + 1 }, now);
    return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
  });
}

/**
 * `POST …/requests/:rid/cancel`: "stop ending" (§4.4). Undecided proposals are
 * `discarded(cancelled)`; confirmed ones (`applied`) and anyone's direct writes stay.
 * Taken whatever the mode is (it confirms nothing), even while `applying` (the decide's
 * remaining writes stop at their fence) and while `ending`.
 */
export function handoffCancel(db: Database.Database, request: ScreenRequest, worktreeId: string, requestId: string, deps: HandoffDeps = {}): HandoffOutcome {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  const now = nowOf(deps);
  return db.transaction((): HandoffOutcome => {
    const found = requestOf(db, worktreeId, requestId);
    if (!found) return handoffError('not_found');
    const row = judgeRequest(db, found, now);
    if (!HANDOFF_OPEN_STATES.includes(row.state) && row.state !== 'ending') return closedRefusal(db, row, now);
    changeHandoffRequest(db, row.id, null, { state: 'cancelled', applyToken: null, endToken: null }, now);
    settleUndecidedProposals(db, row.id, { state: 'discarded', reason: 'cancelled' }, now);
    return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
  })();
}
