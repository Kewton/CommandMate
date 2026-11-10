/**
 * The hand-off records of a session that ends (Issue #4227, migration v71, design
 * `docs/design/mem-ui-4227.md` §4.3). SQL only: the rules of when a request moves are in
 * `src/lib/handoff/**`. Every function is synchronous (better-sqlite3), so a check and
 * the write it guards run in one stretch.
 *
 * Writes `mem_handoff_requests` and `mem_handoff_proposals` only. `mem_items` is read
 * here (what changed on the branch without a proposal, §4.1 ④) and never written: an
 * item is written by mem's service (`memWriteFromScreen`) alone.
 *
 * The pinned columns of a request and what a proposal is about are never in a SET
 * (the v71 triggers refuse them too); `end_forced` is written as `MAX(end_forced, ?)`
 * only, so once forced a request stays forced.
 *
 * @module lib/db/handoff-db
 */

import { createHash } from 'crypto';
import type Database from 'better-sqlite3';

export type HandoffRequestState = 'awaiting_agent' | 'reviewing' | 'applying' | 'ending' | 'ended' | 'cancelled' | 'expired';
export type HandoffSendState = 'unsent' | 'sent' | 'failed';
export type HandoffOutcome = 'confirmed' | 'unconfirmed';
export type HandoffProposalOp = 'add' | 'update' | 'close';
export type HandoffProposalState = 'proposed' | 'approved' | 'applied' | 'conflict' | 'discarded' | 'failed' | 'expired';

/** The states a request is still open in (one per worktree and instance, the v71 index). */
export const HANDOFF_OPEN_STATES: readonly HandoffRequestState[] = ['awaiting_agent', 'reviewing', 'applying'];
/** The states of a proposal not decided yet. */
export const HANDOFF_UNDECIDED_STATES: readonly HandoffProposalState[] = ['proposed', 'approved', 'conflict'];

export interface HandoffRequestRow {
  id: string;
  repositoryId: string;
  branch: string | null;
  detached: boolean;
  targetWorktreeId: string;
  targetWorktreeIncarnation: string;
  instanceId: string;
  cliToolId: string;
  instanceIncarnation: string | null;
  instanceOnRoster: boolean;
  boundaryId: string;
  state: HandoffRequestState;
  sendState: HandoffSendState;
  applyToken: string | null;
  endToken: string | null;
  endForced: boolean;
  outcome: HandoffOutcome | null;
  outcomeReason: string | null;
  agentDeadlineAt: number;
  extensions: number;
  expiresAt: number;
  agentDoneAt: number | null;
  endedAt: number | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

/** What a proposal carries (the fields A's checks passed). */
export interface HandoffPayload {
  kind?: string;
  text?: string;
  closeWhen?: string;
  evidence?: string[];
  promoteTo?: string;
  reason?: string;
}

export interface HandoffProposalRow {
  id: string;
  requestId: string;
  op: HandoffProposalOp;
  itemId: string | null;
  kind: string;
  baseVersion: number | null;
  revision: number;
  payload: HandoffPayload;
  /** The JSON as stored (the fingerprint is of this text). */
  payloadText: string;
  fingerprint: string;
  authorInstanceId: string;
  authorIncarnation: string | null;
  state: HandoffProposalState;
  stateReason: string | null;
  applyToken: string | null;
  approvedFingerprint: string | null;
  appliedItemId: string | null;
  appliedVersion: number | null;
  checkedRulesVersion: number;
  createdAt: number;
  decidedAt: number | null;
  updatedAt: number;
}

interface RawRequest {
  id: string;
  repository_id: string;
  branch: string | null;
  detached: number;
  target_worktree_id: string;
  target_worktree_incarnation: string;
  instance_id: string;
  cli_tool_id: string;
  instance_incarnation: string | null;
  instance_on_roster: number;
  boundary_id: string;
  state: HandoffRequestState;
  send_state: HandoffSendState;
  apply_token: string | null;
  end_token: string | null;
  end_forced: number;
  outcome: HandoffOutcome | null;
  outcome_reason: string | null;
  agent_deadline_at: number;
  extensions: number;
  expires_at: number;
  agent_done_at: number | null;
  ended_at: number | null;
  created_at: number;
  updated_at: number;
  version: number;
}

interface RawProposal {
  id: string;
  request_id: string;
  op: HandoffProposalOp;
  item_id: string | null;
  kind: string;
  base_version: number | null;
  revision: number;
  payload: string;
  fingerprint: string;
  author_instance_id: string;
  author_incarnation: string | null;
  state: HandoffProposalState;
  state_reason: string | null;
  apply_token: string | null;
  approved_fingerprint: string | null;
  applied_item_id: string | null;
  applied_version: number | null;
  checked_rules_version: number;
  created_at: number;
  decided_at: number | null;
  updated_at: number;
}

function toRequest(raw: RawRequest): HandoffRequestRow {
  return {
    id: raw.id,
    repositoryId: raw.repository_id,
    branch: raw.branch,
    detached: raw.detached === 1,
    targetWorktreeId: raw.target_worktree_id,
    targetWorktreeIncarnation: raw.target_worktree_incarnation,
    instanceId: raw.instance_id,
    cliToolId: raw.cli_tool_id,
    instanceIncarnation: raw.instance_incarnation,
    instanceOnRoster: raw.instance_on_roster === 1,
    boundaryId: raw.boundary_id,
    state: raw.state,
    sendState: raw.send_state,
    applyToken: raw.apply_token,
    endToken: raw.end_token,
    endForced: raw.end_forced === 1,
    outcome: raw.outcome,
    outcomeReason: raw.outcome_reason,
    agentDeadlineAt: raw.agent_deadline_at,
    extensions: raw.extensions,
    expiresAt: raw.expires_at,
    agentDoneAt: raw.agent_done_at,
    endedAt: raw.ended_at,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    version: raw.version,
  };
}

function readPayload(text: string): HandoffPayload {
  try {
    const value = JSON.parse(text) as unknown;
    return value && typeof value === 'object' ? (value as HandoffPayload) : {};
  } catch {
    return {};
  }
}

function toProposal(raw: RawProposal): HandoffProposalRow {
  return {
    id: raw.id,
    requestId: raw.request_id,
    op: raw.op,
    itemId: raw.item_id,
    kind: raw.kind,
    baseVersion: raw.base_version,
    revision: raw.revision,
    payload: readPayload(raw.payload),
    payloadText: raw.payload,
    fingerprint: raw.fingerprint,
    authorInstanceId: raw.author_instance_id,
    authorIncarnation: raw.author_incarnation,
    state: raw.state,
    stateReason: raw.state_reason,
    applyToken: raw.apply_token,
    approvedFingerprint: raw.approved_fingerprint,
    appliedItemId: raw.applied_item_id,
    appliedVersion: raw.applied_version,
    checkedRulesVersion: raw.checked_rules_version,
    createdAt: raw.created_at,
    decidedAt: raw.decided_at,
    updatedAt: raw.updated_at,
  };
}

// ---------------------------------------------------------------------------
// The fingerprint (§4.3・§4.5.1): what a person saw and approved
// ---------------------------------------------------------------------------

export interface FingerprintInput {
  requestId: string;
  id: string;
  revision: number;
  op: HandoffProposalOp;
  itemId: string | null;
  kind: string;
  baseVersion: number | null;
  payloadText: string;
}

/**
 * SHA-256 of `{request_id, id, revision, op, item_id, kind, base_version, payload}` as a
 * JSON array in that fixed order (H18(b): any one of them changes it).
 */
export function proposalFingerprint(input: FingerprintInput): string {
  const canonical = JSON.stringify([
    input.requestId,
    input.id,
    input.revision,
    input.op,
    input.itemId,
    input.kind,
    input.baseVersion,
    input.payloadText,
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/** The fingerprint of a stored row, computed again from its columns (not read from `fingerprint`). */
export function fingerprintOfRow(row: HandoffProposalRow): string {
  return proposalFingerprint({
    requestId: row.requestId,
    id: row.id,
    revision: row.revision,
    op: row.op,
    itemId: row.itemId,
    kind: row.kind,
    baseVersion: row.baseVersion,
    payloadText: row.payloadText,
  });
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

export interface NewHandoffRequest {
  id: string;
  repositoryId: string;
  branch: string | null;
  detached: boolean;
  targetWorktreeId: string;
  targetWorktreeIncarnation: string;
  instanceId: string;
  cliToolId: string;
  instanceIncarnation: string | null;
  instanceOnRoster: boolean;
  boundaryId: string;
  agentDeadlineAt: number;
  expiresAt: number;
  now: number;
}

export function insertHandoffRequest(db: Database.Database, input: NewHandoffRequest): HandoffRequestRow {
  db.prepare(
    `INSERT INTO mem_handoff_requests (id, repository_id, branch, detached, target_worktree_id, target_worktree_incarnation,
       instance_id, cli_tool_id, instance_incarnation, instance_on_roster, boundary_id, state, agent_deadline_at, expires_at,
       created_at, updated_at, version)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'awaiting_agent', ?, ?, ?, ?, 1)`
  ).run(
    input.id,
    input.repositoryId,
    input.branch,
    input.detached ? 1 : 0,
    input.targetWorktreeId,
    input.targetWorktreeIncarnation,
    input.instanceId,
    input.cliToolId,
    input.instanceIncarnation,
    input.instanceOnRoster ? 1 : 0,
    input.boundaryId,
    input.agentDeadlineAt,
    input.expiresAt,
    input.now,
    input.now
  );
  return getHandoffRequest(db, input.id)!;
}

export function getHandoffRequest(db: Database.Database, id: string): HandoffRequestRow | null {
  const raw = db.prepare('SELECT * FROM mem_handoff_requests WHERE id = ?').get(id) as RawRequest | undefined;
  return raw ? toRequest(raw) : null;
}

/** The open request of one (worktree, instance), if any. */
export function getOpenHandoffRequest(db: Database.Database, worktreeId: string, instanceId: string): HandoffRequestRow | null {
  const raw = db
    .prepare(
      `SELECT * FROM mem_handoff_requests WHERE target_worktree_id = ? AND instance_id = ?
         AND state IN ('awaiting_agent','reviewing','applying')`
    )
    .get(worktreeId, instanceId) as RawRequest | undefined;
  return raw ? toRequest(raw) : null;
}

/** Requests of a worktree that are not over yet (open or ending), newest first. */
export function listLiveHandoffRequests(db: Database.Database, worktreeId: string): HandoffRequestRow[] {
  return (
    db
      .prepare(
        `SELECT * FROM mem_handoff_requests WHERE target_worktree_id = ?
           AND state IN ('awaiting_agent','reviewing','applying','ending') ORDER BY created_at DESC`
      )
      .all(worktreeId) as RawRequest[]
  ).map(toRequest);
}

/**
 * The fields of a request a step changes. The pinned columns are not here (the v71
 * trigger refuses them as well), and `end_forced` is not either: see {@link raiseEndForced}.
 */
export interface HandoffRequestChange {
  state?: HandoffRequestState;
  sendState?: HandoffSendState;
  applyToken?: string | null;
  endToken?: string | null;
  outcome?: HandoffOutcome | null;
  outcomeReason?: string | null;
  agentDeadlineAt?: number;
  extensions?: number;
  agentDoneAt?: number | null;
  endedAt?: number | null;
}

const REQUEST_COLUMNS: Record<keyof HandoffRequestChange, string> = {
  state: 'state',
  sendState: 'send_state',
  applyToken: 'apply_token',
  endToken: 'end_token',
  outcome: 'outcome',
  outcomeReason: 'outcome_reason',
  agentDeadlineAt: 'agent_deadline_at',
  extensions: 'extensions',
  agentDoneAt: 'agent_done_at',
  endedAt: 'ended_at',
};

/**
 * Change a request when its version is still `expectVersion` (null: whatever it is),
 * and raise the version. False: it moved since (nothing written).
 */
export function changeHandoffRequest(
  db: Database.Database,
  id: string,
  expectVersion: number | null,
  change: HandoffRequestChange,
  now: number
): boolean {
  const keys = Object.keys(change) as Array<keyof HandoffRequestChange>;
  const sets = keys.map((key) => `${REQUEST_COLUMNS[key]} = ?`);
  const values = keys.map((key) => change[key] ?? null);
  const where = expectVersion === null ? 'id = ?' : 'id = ? AND version = ?';
  const result = db
    .prepare(`UPDATE mem_handoff_requests SET ${[...sets, 'updated_at = ?', 'version = version + 1'].join(', ')} WHERE ${where}`)
    .run(...values, now, id, ...(expectVersion === null ? [] : [expectVersion]));
  return result.changes === 1;
}

/** Forced once, forced for good: `MAX(end_forced, ?)` (§4.6 1, the v71 trigger refuses 1 → 0). */
export function raiseEndForced(db: Database.Database, id: string, forced: boolean): void {
  db.prepare('UPDATE mem_handoff_requests SET end_forced = MAX(end_forced, ?) WHERE id = ?').run(forced ? 1 : 0, id);
}

/**
 * Requests that ended, were cancelled or expired before `before`, with their proposals
 * (14 days, §4.3). Open and ending ones are never removed here.
 */
export function purgeOldHandoffRequests(db: Database.Database, before: number): number {
  return db
    .prepare(`DELETE FROM mem_handoff_requests WHERE state IN ('ended','cancelled','expired') AND updated_at < ?`)
    .run(before).changes;
}

// ---------------------------------------------------------------------------
// Proposals
// ---------------------------------------------------------------------------

export interface NewHandoffProposal {
  id: string;
  requestId: string;
  op: HandoffProposalOp;
  itemId: string | null;
  kind: string;
  baseVersion: number | null;
  payload: HandoffPayload;
  authorInstanceId: string;
  authorIncarnation: string | null;
  checkedRulesVersion: number;
  now: number;
}

export function insertHandoffProposal(db: Database.Database, input: NewHandoffProposal): HandoffProposalRow {
  const payloadText = JSON.stringify(input.payload);
  const fingerprint = proposalFingerprint({
    requestId: input.requestId,
    id: input.id,
    revision: 1,
    op: input.op,
    itemId: input.itemId,
    kind: input.kind,
    baseVersion: input.baseVersion,
    payloadText,
  });
  db.prepare(
    `INSERT INTO mem_handoff_proposals (id, request_id, op, item_id, kind, base_version, revision, payload, fingerprint,
       author_instance_id, author_incarnation, state, checked_rules_version, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'proposed', ?, ?, ?)`
  ).run(
    input.id,
    input.requestId,
    input.op,
    input.itemId,
    input.kind,
    input.baseVersion,
    payloadText,
    fingerprint,
    input.authorInstanceId,
    input.authorIncarnation,
    input.checkedRulesVersion,
    input.now,
    input.now
  );
  return getHandoffProposal(db, input.id)!;
}

export function getHandoffProposal(db: Database.Database, id: string): HandoffProposalRow | null {
  const raw = db.prepare('SELECT * FROM mem_handoff_proposals WHERE id = ?').get(id) as RawProposal | undefined;
  return raw ? toProposal(raw) : null;
}

export function listHandoffProposals(db: Database.Database, requestId: string): HandoffProposalRow[] {
  return (
    db.prepare('SELECT * FROM mem_handoff_proposals WHERE request_id = ? ORDER BY created_at, id').all(requestId) as RawProposal[]
  ).map(toProposal);
}

/** Set a proposal's state (and its mark), from one of `from` only. False: it was not in one of them. */
export function setHandoffProposalState(
  db: Database.Database,
  id: string,
  from: readonly HandoffProposalState[],
  to: { state: HandoffProposalState; reason?: string | null; applyToken?: string | null; approvedFingerprint?: string | null },
  now: number
): boolean {
  const marks = from.map(() => '?').join(',');
  const decided = to.state === 'proposed' || to.state === 'conflict' ? null : now;
  return (
    db
      .prepare(
        `UPDATE mem_handoff_proposals SET state = ?, state_reason = ?, apply_token = ?, approved_fingerprint = ?,
           decided_at = COALESCE(?, decided_at), updated_at = ? WHERE id = ? AND state IN (${marks})`
      )
      .run(to.state, to.reason ?? null, to.applyToken ?? null, to.approvedFingerprint ?? null, decided, now, id, ...from).changes === 1
  );
}

/** Every undecided proposal of a request to `to` (cancel, force, expiry). */
export function settleUndecidedProposals(
  db: Database.Database,
  requestId: string,
  to: { state: 'discarded' | 'expired'; reason: string },
  now: number
): number {
  return db
    .prepare(
      `UPDATE mem_handoff_proposals SET state = ?, state_reason = ?, apply_token = NULL, decided_at = ?, updated_at = ?
         WHERE request_id = ? AND state IN ('proposed','approved','conflict')`
    )
    .run(to.state, to.reason, now, now, requestId).changes;
}

/**
 * A rebase (§4.5.1): a new base version and revision, the fingerprint computed again, and
 * the proposal back to `proposed`. From `conflict` with `expectFingerprint` only.
 */
export function rebaseHandoffProposal(
  db: Database.Database,
  row: HandoffProposalRow,
  baseVersion: number,
  now: number
): HandoffProposalRow | null {
  const revision = row.revision + 1;
  const fingerprint = proposalFingerprint({
    requestId: row.requestId,
    id: row.id,
    revision,
    op: row.op,
    itemId: row.itemId,
    kind: row.kind,
    baseVersion,
    payloadText: row.payloadText,
  });
  const changed = db
    .prepare(
      `UPDATE mem_handoff_proposals SET base_version = ?, revision = ?, fingerprint = ?, state = 'proposed', state_reason = NULL,
         apply_token = NULL, approved_fingerprint = NULL, updated_at = ?
       WHERE id = ? AND state = 'conflict' AND fingerprint = ?`
    )
    .run(baseVersion, revision, fingerprint, now, row.id, row.fingerprint).changes;
  return changed === 1 ? getHandoffProposal(db, row.id) : null;
}

// ---------------------------------------------------------------------------
// The mark of a person's approval (PM P3-a)
// ---------------------------------------------------------------------------

/**
 * What `decide` hands mem's service with a confirmation: which proposal, which
 * decide (its token) and the content a person approved. The service judges it by
 * the stored rows only ({@link approvalMarkHolds}), never by what a request says.
 */
export interface HandoffApprovalMark {
  proposalId: string;
  applyToken: string;
  fingerprint: string;
}

/**
 * Whether the mark is good now, read from the rows (PM P3-a (1)(2)): the proposal is
 * `approved` under this decide's token, the fingerprint the person approved is the
 * one its columns give now (a change after the approval spoils it), it is about this
 * op and item, and its request is `applying` under the same token for this worktree
 * and instance. Once used ({@link consumeApprovalMark}) it is `applied` and holds no more.
 */
export function approvalMarkHolds(
  db: Database.Database,
  mark: HandoffApprovalMark,
  write: { op: HandoffProposalOp; itemId: string | null; worktreeId: string; instanceId: string }
): boolean {
  const proposal = getHandoffProposal(db, mark.proposalId);
  if (!proposal || proposal.state !== 'approved' || proposal.applyToken !== mark.applyToken) return false;
  if (proposal.approvedFingerprint !== mark.fingerprint || proposal.fingerprint !== mark.fingerprint) return false;
  if (fingerprintOfRow(proposal) !== mark.fingerprint) return false;
  if (proposal.op !== write.op || proposal.itemId !== write.itemId) return false;
  const request = getHandoffRequest(db, proposal.requestId);
  if (!request || request.state !== 'applying' || request.applyToken !== mark.applyToken) return false;
  return request.targetWorktreeId === write.worktreeId && request.instanceId === write.instanceId;
}

/** Use the mark: the proposal is `applied` (the token gone), in the write's transaction. */
export function consumeApprovalMark(
  db: Database.Database,
  mark: HandoffApprovalMark,
  applied: { itemId: string; version: number },
  now: number
): boolean {
  return (
    db
      .prepare(
        `UPDATE mem_handoff_proposals SET state = 'applied', state_reason = NULL, apply_token = NULL, applied_item_id = ?,
           applied_version = ?, decided_at = ?, updated_at = ?
         WHERE id = ? AND state = 'approved' AND apply_token = ? AND approved_fingerprint = ?`
      )
      .run(applied.itemId, applied.version, now, now, mark.proposalId, mark.applyToken, mark.fingerprint).changes === 1
  );
}

// ---------------------------------------------------------------------------
// What changed on the branch without a proposal (read only, §4.1 ④・G2)
// ---------------------------------------------------------------------------

export interface DirectItemChange {
  id: string;
  kind: string;
  state: string;
  version: number;
  updatedBy: string;
  updatedByInstance: string | null;
  updatedAt: number;
}

/**
 * Items of the branch an agent wrote after `since`, except those `excluded` (the proposals' own).
 * A detached HEAD (`branch` null) is one worktree's own, as in mem's lists (`mem-db.ts`
 * `scopeClause`): the items of the request's worktree only, by `origin_worktree_id`
 * (codex review-4227-pr2 P2-3) — another detached worktree of the repository is not this one.
 */
export function listDirectItemChanges(
  db: Database.Database,
  repositoryId: string,
  branch: string | null,
  originWorktreeId: string,
  since: number,
  excluded: ReadonlySet<string>
): DirectItemChange[] {
  const scope =
    branch === null
      ? { sql: 'repository_id = ? AND branch IS NULL AND origin_worktree_id = ?', params: [repositoryId, originWorktreeId] }
      : { sql: 'repository_id = ? AND branch = ?', params: [repositoryId, branch] };
  const rows = db
    .prepare(
      `SELECT id, kind, state, version, updated_by, updated_by_instance, updated_at FROM mem_items
         WHERE ${scope.sql} AND updated_at >= ? AND updated_by = 'agent' ORDER BY updated_at DESC LIMIT 50`
    )
    .all(...scope.params, since) as Array<{
    id: string;
    kind: string;
    state: string;
    version: number;
    updated_by: string;
    updated_by_instance: string | null;
    updated_at: number;
  }>;
  return rows
    .filter((row) => !excluded.has(row.id))
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      state: row.state,
      version: row.version,
      updatedBy: row.updated_by,
      updatedByInstance: row.updated_by_instance,
      updatedAt: row.updated_at,
    }));
}
