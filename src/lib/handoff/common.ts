/**
 * What every entrance of the hand-off shares (Issue #4227, design `mem-ui-4227.md`
 * §4.3・§4.4): the answers, the conversation's lifetime, the judgement made when a
 * request is read (expiry and a changed session) and the mode of the request's branch.
 *
 * Nothing here kills, starts or types into a session, and nothing runs in the
 * background: a request's deadline is judged when it is read (§4.3, the guards
 * `handoff-no-resident-4227` and `handoff-no-kill-4227`).
 *
 * @module lib/handoff/common
 */

import type Database from 'better-sqlite3';
import { getAllRepositories } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { getCurrentBoundary, isSameInstanceLifetime, readInstanceLifetime } from '@/lib/db/session-brief-db';
import {
  changeHandoffRequest,
  getHandoffRequest,
  HANDOFF_OPEN_STATES,
  listDirectItemChanges,
  listHandoffProposals,
  settleUndecidedProposals,
  type HandoffProposalRow,
  type HandoffRequestRow,
} from '@/lib/db/handoff-db';
import { getMemRecord } from '@/lib/db/mem-db';
import { getWorktreeIncarnation } from '@/lib/mem/incarnation';
import { presentMemItem } from '@/lib/mem/present';
import { findSecretRule, MEM_SECRET_RULES, MEM_SECRET_RULES_VERSION, type MemSecretRule } from '@/lib/mem/secret-scan';
import { withMemTarget, type MemTargetDeps, type MemTargetResolved } from '@/lib/mem/target';
import { memError } from '@/lib/mem/service';
import type {
  HandoffErrorCode,
  HandoffProposalView,
  HandoffReadResponse,
  HandoffRequestView,
} from './types';

export interface HandoffOutcome {
  status: number;
  body: unknown;
}

export interface HandoffDeps extends MemTargetDeps {
  now?: () => number;
}

export const nowOf = (deps: HandoffDeps): number => deps.now?.() ?? Date.now();

const MESSAGES: Record<HandoffErrorCode, string> = {
  screen_only: 'This change is made from the screen only',
  not_found: 'No such hand-off request',
  unattended: 'The branch is not set to show the hand-off (popup is off)',
  session_unknown: 'No conversation is known for this instance yet',
  request_open: 'A hand-off request is already open for this instance',
  session_changed: 'The session is not the one the request was made for',
  request_closed: 'The request no longer takes this',
  version_conflict: 'The request changed since that version',
  not_requested: 'The request was made to another instance',
  proposal_changed: 'The proposal is not the one that was seen',
  state_forbids: 'The request or the item is in a state that does not allow this',
  extend_limit: 'The agent’s time was extended as often as allowed',
  not_stopped: 'The session was not seen stopped',
  end_token_changed: 'The stop is not the one declared',
  already_recorded: 'How the session ended is already recorded',
};

export function handoffError(code: HandoffErrorCode, extra: Record<string, unknown> = {}): HandoffOutcome {
  const status = code === 'not_found' ? 404 : code === 'screen_only' ? 403 : 409;
  return { status, body: { ...extra, ok: false, code, message: MESSAGES[code] } };
}

/** 400 with the field that is wrong (nothing stored). */
export const invalidRequest = (field: string): HandoffOutcome => memError('invalid_request', { field });

const iso = (epoch: number | null): string | null => (epoch === null ? null : new Date(epoch).toISOString());

export function requestView(row: HandoffRequestRow, now: number): HandoffRequestView {
  return {
    id: row.id,
    worktreeId: row.targetWorktreeId,
    instanceId: row.instanceId,
    cliToolId: row.cliToolId,
    branch: row.branch,
    detached: row.detached,
    state: row.state,
    sendState: row.sendState,
    endForced: row.endForced,
    endToken: row.endToken,
    outcome: row.outcome,
    outcomeReason: row.outcomeReason,
    agentDeadlineAt: iso(row.agentDeadlineAt) as string,
    extensions: row.extensions,
    expiresAt: iso(row.expiresAt) as string,
    agentDoneAt: iso(row.agentDoneAt),
    endedAt: iso(row.endedAt),
    agentTimedOut: row.state === 'awaiting_agent' && row.agentDoneAt === null && now >= row.agentDeadlineAt,
    version: row.version,
  };
}

/** A proposal as it leaves the server: its fields re-read against the current rules (H12, A §6.4). */
export function proposalView(
  db: Database.Database,
  row: HandoffProposalRow,
  rules: { list: readonly MemSecretRule[]; version: number } = { list: MEM_SECRET_RULES, version: MEM_SECRET_RULES_VERSION }
): HandoffProposalView {
  const record = row.itemId ? getMemRecord(db, row.itemId) : null;
  const view: HandoffProposalView = {
    id: row.id,
    op: row.op,
    itemId: row.itemId,
    kind: row.kind,
    baseVersion: row.baseVersion,
    revision: row.revision,
    fingerprint: row.fingerprint,
    state: row.state,
    stateReason: row.stateReason,
    current: record ? presentMemItem(record) : null,
    appliedItemId: row.appliedItemId,
    appliedVersion: row.appliedVersion,
  };
  if (row.checkedRulesVersion < rules.version) {
    const fields: Array<[string, string]> = [];
    if (row.payload.text !== undefined) fields.push(['text', row.payload.text]);
    if (row.payload.reason !== undefined) fields.push(['reason', row.payload.reason]);
    if (row.payload.promoteTo !== undefined) fields.push(['promoteTo', row.payload.promoteTo]);
    (row.payload.evidence ?? []).forEach((entry) => fields.push(['evidence', entry]));
    for (const [field, value] of fields) {
      const rule = findSecretRule(value, rules.list);
      if (rule) return { ...view, withheld: { field, rule } };
    }
  }
  return { ...view, payload: row.payload };
}

/** The request, its proposals and what changed without a proposal, as the screen reads them. */
export function readView(db: Database.Database, row: HandoffRequestRow, now: number): HandoffReadResponse {
  const proposals = listHandoffProposals(db, row.id);
  const applied = new Set(proposals.map((proposal) => proposal.appliedItemId).filter((id): id is string => id !== null));
  const direct = listDirectItemChanges(db, row.repositoryId, row.branch, row.targetWorktreeId, row.createdAt, applied).map((change) => ({
    id: change.id,
    kind: change.kind,
    state: change.state,
    version: change.version,
    updatedByInstance: change.updatedByInstance,
    updatedAt: iso(change.updatedAt) as string,
  }));
  return { ok: true, request: requestView(row, now), proposals: proposals.map((proposal) => proposalView(db, proposal)), direct };
}

/**
 * Whether the conversation the request was made for is still the one running (§0.1 G6):
 * the worktree's lifetime, the instance's current D1 boundary and its lifetime on the
 * roster (`isSameInstanceLifetime`, so the lawful `null → lazy` issue is the same).
 * Read only.
 */
export function sameConversation(db: Database.Database, row: HandoffRequestRow): boolean {
  if (!getWorktreeById(db, row.targetWorktreeId)) return false;
  if (getWorktreeIncarnation(db, row.targetWorktreeId) !== row.targetWorktreeIncarnation) return false;
  const boundary = getCurrentBoundary(db, row.targetWorktreeId, row.instanceId);
  if (!boundary || boundary.id !== row.boundaryId) return false;
  return isSameInstanceLifetime(
    { incarnation: row.instanceIncarnation, onRoster: row.instanceOnRoster },
    readInstanceLifetime(db, row.targetWorktreeId, row.instanceId),
    row.cliToolId
  );
}

/** A request over: `expired` with the reason, its undecided proposals `expired`, tokens gone. */
export function expireRequest(db: Database.Database, row: HandoffRequestRow, reason: 'expired' | 'session_changed', now: number): void {
  changeHandoffRequest(db, row.id, null, { state: 'expired', outcomeReason: reason, applyToken: null }, now);
  settleUndecidedProposals(db, row.id, { state: 'expired', reason }, now);
}

/**
 * The judgement made whenever a request is read or written (§4.3・§4.4, synchronous):
 *
 * - open (`awaiting_agent`・`reviewing`・`applying`): past `expires_at` → `expired`; the
 *   conversation changed (a restart, a re-created worktree, the instance gone) →
 *   `expired(session_changed)`.
 * - `ending` (the stop declared): only its `expires_at` ends it here. A changed
 *   conversation is left to the observation of the same stop (`end/observe`), which
 *   records `unconfirmed(session_changed)` — the 6th review's P2(2).
 *
 * Kills nothing. Answers the request as it is now.
 */
export function judgeRequest(db: Database.Database, row: HandoffRequestRow, now: number): HandoffRequestRow {
  if (HANDOFF_OPEN_STATES.includes(row.state)) {
    if (now >= row.expiresAt) expireRequest(db, row, 'expired', now);
    else if (!sameConversation(db, row)) expireRequest(db, row, 'session_changed', now);
    else return row;
    return getHandoffRequest(db, row.id) as HandoffRequestRow;
  }
  if (row.state === 'ending' && now >= row.expiresAt) {
    expireRequest(db, row, 'expired', now);
    return getHandoffRequest(db, row.id) as HandoffRequestRow;
  }
  return row;
}

/**
 * The refusal for a request that is not open (after {@link judgeRequest}): a request a
 * changed conversation ended answers `session_changed`, any other `request_closed`.
 */
export function closedRefusal(db: Database.Database, row: HandoffRequestRow, now: number): HandoffOutcome {
  const extra = { request: requestView(row, now) };
  if (row.state === 'expired' && row.outcomeReason === 'session_changed') return handoffError('session_changed', extra);
  return handoffError('request_closed', extra);
}

/** The request of this worktree, or null (another worktree's id is not found here). */
export function requestOf(db: Database.Database, worktreeId: string, requestId: string): HandoffRequestRow | null {
  const row = getHandoffRequest(db, requestId);
  return row && row.targetWorktreeId === worktreeId ? row : null;
}

/**
 * The mode of a worktree's branch, resolved as mem resolves it, then `build` in one
 * transaction in the synchronous stretch after git answered. `branch` names the
 * request's branch (its mode, not the one HEAD moved to); undefined is HEAD's.
 */
export async function withBranchMode(
  db: Database.Database,
  worktreeId: string,
  branch: string | null | undefined,
  deps: HandoffDeps,
  build: (target: MemTargetResolved) => HandoffOutcome
): Promise<HandoffOutcome> {
  if (getAllRepositories(db).length === 0) return memError('not_registered');
  const spec = branch === undefined || branch === null ? { via: 'worktree' as const, worktreeId } : { via: 'worktree' as const, worktreeId, branch };
  return withMemTarget(db, spec, deps, (target) => {
    if (!target.ok) return memError(target.code, target.reason ? { reason: target.reason } : {});
    return db.transaction(() => build(target))();
  });
}

/** `disabled` (50 in the CLI) unless the branch's mode is `on`. */
export function modeRefusal(target: MemTargetResolved): HandoffOutcome | null {
  return target.mode === 'on' ? null : memError('disabled', { mode: target.mode, source: target.source });
}

export const isVersion = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0;
