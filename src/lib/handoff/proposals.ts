/**
 * The agent's side of a hand-off (`commandmate handoff propose` / `done`) and the
 * screen's rebase of a proposal that met a newer item (Issue #4227, design
 * `mem-ui-4227.md` §4.3・§4.5.1).
 *
 * A proposal is one operation on one item — add, an update or a close with the
 * version the agent saw — checked with A's checks when it arrives (A checks it again
 * when it is confirmed). It never confirms anything: only a person's `decide` does.
 * There is no record / promote operation (D9): a decision is proposed as an add (open)
 * or the withdrawal of an open one; a recorded decision's close is refused.
 *
 * The agent's entrances need no screen mark (the mark adds no right to them); they
 * need the request's own instance (409 `not_requested`), the same conversation (409
 * `session_changed`, the old request `expired`) and mode `on` (`disabled`, 50).
 *
 * @module lib/handoff/proposals
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getWorktreeById } from '@/lib/db/worktree-db';
import {
  changeHandoffRequest,
  getHandoffProposal,
  getHandoffRequest,
  HANDOFF_OPEN_STATES,
  insertHandoffProposal,
  rebaseHandoffProposal,
  type HandoffPayload,
  type HandoffProposalOp,
  type HandoffRequestRow,
} from '@/lib/db/handoff-db';
import { getMemRecord } from '@/lib/db/mem-db';
import { checkCloseWhenBindable, parseCloseWhen, type CloseWhenGitAnswers } from '@/lib/mem/close-when';
import { MEM_SECRET_RULES_VERSION } from '@/lib/mem/secret-scan';
import { memError } from '@/lib/mem/service';
import { memTransition } from '@/lib/mem/transitions';
import { validateEvidence, validateItemText, validateMemFields, validateReason, type MemFieldError } from '@/lib/mem/validate';
import { isScreenRequest } from '@/lib/security/screen-request';
import { isMemKind } from '@/types/mem';
import type { MemTargetResolved } from '@/lib/mem/target';
import {
  closedRefusal,
  handoffError,
  invalidRequest,
  isVersion,
  judgeRequest,
  modeRefusal,
  nowOf,
  proposalView,
  readView,
  requestOf,
  withBranchMode,
  type HandoffDeps,
  type HandoffOutcome,
} from './common';

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

const PROPOSAL_OPS: readonly HandoffProposalOp[] = ['add', 'update', 'close'];

const fieldError = (error: MemFieldError): HandoffOutcome =>
  memError(error.code, { field: error.field, ...(error.rule ? { rule: error.rule } : {}), ...(error.limit ? { limit: error.limit } : {}) });

/** The request still takes the agent's proposals and `done`: open, waiting for the agent, in time, not forced. */
function agentRefusal(db: Database.Database, row: HandoffRequestRow, instanceId: unknown, now: number): HandoffOutcome | null {
  if (!HANDOFF_OPEN_STATES.includes(row.state)) return closedRefusal(db, row, now);
  if (typeof instanceId !== 'string' || instanceId !== row.instanceId) return handoffError('not_requested');
  if (row.endForced || row.state !== 'awaiting_agent' || now >= row.agentDeadlineAt) {
    return handoffError('request_closed', { request: readView(db, row, now).request });
  }
  return null;
}

/** Whether a stored item is of the request's branch (the proposal names an item of it only). */
function itemOfRequest(target: MemTargetResolved, row: HandoffRequestRow, record: { owner: { repositoryId: string; branch: string | null; worktreeId: string } }): boolean {
  if (!target.readRepositoryIds.includes(record.owner.repositoryId)) return false;
  if (record.owner.branch !== row.branch) return false;
  return row.branch !== null || record.owner.worktreeId === row.targetWorktreeId;
}

/** True when git's answers make the condition unbindable (no origin for `#N`, no tip for `merged`...), as `mem add` finds. */
type BindRefusal = boolean;

/** Asks git as `mem add` does, before the synchronous checks; false when the condition is not asked about or binds. */
async function bindRefusalOf(db: Database.Database, worktreeId: string, body: Record<string, unknown>, deps: HandoffDeps): Promise<BindRefusal> {
  let kind: string | null = null;
  if (body.op === 'add') kind = isMemKind(body.kind) && body.kind !== 'now' ? body.kind : null;
  else if (body.op === 'update' && body.closeWhen !== undefined && typeof body.itemId === 'string') kind = getMemRecord(db, body.itemId)?.kind ?? null;
  if (kind === null || !isMemKind(kind)) return false;
  const draft = parseCloseWhen(kind, body.closeWhen);
  const worktree = getWorktreeById(db, worktreeId);
  if (!draft.ok || !worktree) return false;
  const observe = deps.git ? null : await import('@/lib/mem/git-observe');
  const git: CloseWhenGitAnswers = deps.git ?? { originUrl: observe!.readOriginUrl, refTip: observe!.readRefTip };
  const bound = await checkCloseWhenBindable(draft.draft, worktree.path, git, (id) => getWorktreeById(db, id) !== null);
  return !bound.ok;
}

type Checked = { ok: true; itemId: string | null; kind: string; baseVersion: number | null; payload: HandoffPayload } | { ok: false; outcome: HandoffOutcome };

/** A's checks of the proposal (the same ones the confirmation runs again, A §6.4). */
function checkProposal(db: Database.Database, body: Record<string, unknown>, root: string, target: MemTargetResolved, row: HandoffRequestRow, now: number, bindRefusal: BindRefusal): Checked {
  const fail = (outcome: HandoffOutcome): Checked => ({ ok: false, outcome });
  const op = body.op as HandoffProposalOp;
  if (op === 'add') {
    if (!isMemKind(body.kind) || body.kind === 'now') return fail(invalidRequest('kind'));
    const kind = body.kind;
    const fields = validateMemFields(kind, { text: body.text, evidence: body.evidence, promoteTo: body.promoteTo }, root, now);
    if (!fields.ok) return fail(fieldError(fields.error));
    const draft = parseCloseWhen(kind, body.closeWhen);
    if (!draft.ok) return fail(memError('invalid_close_when', { field: 'closeWhen', reason: draft.reason }));
    if (bindRefusal) return fail(memError('invalid_close_when', { field: 'closeWhen' }));
    const payload: HandoffPayload = { kind, text: fields.value.text };
    if (typeof body.closeWhen === 'string') payload.closeWhen = body.closeWhen;
    if (fields.value.evidence.length > 0) payload.evidence = fields.value.evidence;
    if (fields.value.promoteTo !== null) payload.promoteTo = fields.value.promoteTo;
    return { ok: true, itemId: null, kind, baseVersion: null, payload };
  }
  if (typeof body.itemId !== 'string' || body.itemId.length === 0) return fail(invalidRequest('itemId'));
  if (!isVersion(body.baseVersion)) return fail(invalidRequest('baseVersion'));
  const record = getMemRecord(db, body.itemId);
  if (!record || !itemOfRequest(target, row, record)) return fail(memError('item_not_found'));
  // `now` is the #2427 note's path; a proposal never touches it (§4.3).
  if (record.kind === 'now') return fail(invalidRequest('kind'));
  const transition = memTransition(record.kind, record.state, op === 'update' ? 'update' : 'close');
  // A decision's close is the withdrawal of an open one only (a recorded one is the person's, S-D).
  if (!transition.ok || (op === 'close' && record.kind === 'decision' && record.state !== 'open')) {
    return fail(handoffError('state_forbids', { itemId: record.id }));
  }
  const payload: HandoffPayload = {};
  if (op === 'update') {
    if (body.text !== undefined) {
      const text = validateItemText(body.text);
      if (!text.ok) return fail(fieldError(text.error));
      if (text.value.length === 0) return fail(invalidRequest('text'));
      payload.text = text.value;
    }
    if (body.evidence !== undefined) {
      const evidence = validateEvidence(body.evidence, root);
      if (!evidence.ok) return fail(fieldError(evidence.error));
      payload.evidence = evidence.value;
    }
    if (body.closeWhen !== undefined) {
      const draft = parseCloseWhen(record.kind, body.closeWhen);
      if (!draft.ok) return fail(memError('invalid_close_when', { field: 'closeWhen', reason: draft.reason }));
      if (bindRefusal) return fail(memError('invalid_close_when', { field: 'closeWhen' }));
      if (typeof body.closeWhen === 'string') payload.closeWhen = body.closeWhen;
    }
    if (Object.keys(payload).length === 0) return fail(invalidRequest('text'));
  } else if (body.reason !== undefined && body.reason !== null) {
    const reason = validateReason(body.reason);
    if (!reason.ok) return fail(fieldError(reason.error));
    if (reason.value.length > 0) payload.reason = reason.value;
  }
  return { ok: true, itemId: record.id, kind: record.kind, baseVersion: body.baseVersion, payload };
}

/** `POST …/requests/:rid/proposals` (the agent's CLI). */
export async function handoffPropose(
  db: Database.Database,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
): Promise<HandoffOutcome> {
  if (!PROPOSAL_OPS.includes(body.op as HandoffProposalOp)) return invalidRequest('op');
  const before = requestOf(db, worktreeId, requestId);
  if (!before) return handoffError('not_found');
  const bindRefusal = await bindRefusalOf(db, worktreeId, body, deps);
  return withBranchMode(db, worktreeId, before.branch, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    const now = nowOf(deps);
    const row = judgeRequest(db, getHandoffRequest(db, requestId)!, now);
    const closed = agentRefusal(db, row, body.instanceId, now);
    if (closed) return closed;
    const worktree = getWorktreeById(db, worktreeId);
    if (!worktree) return handoffError('session_changed');
    const checked = checkProposal(db, body, worktree.path, target, row, now, bindRefusal);
    if (!checked.ok) return checked.outcome;
    const proposal = insertHandoffProposal(db, {
      id: randomUUID(),
      requestId: row.id,
      op: body.op as HandoffProposalOp,
      itemId: checked.itemId,
      kind: checked.kind,
      baseVersion: checked.baseVersion,
      payload: checked.payload,
      authorInstanceId: row.instanceId,
      authorIncarnation: row.instanceIncarnation,
      checkedRulesVersion: MEM_SECRET_RULES_VERSION,
      now,
    });
    changeHandoffRequest(db, row.id, null, {}, now);
    return { status: 201, body: { ok: true, proposal: proposalView(db, proposal) } };
  });
}

/** `POST …/requests/:rid/done` (the agent's CLI): its proposals are all in → `reviewing`. */
export async function handoffDone(
  db: Database.Database,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
): Promise<HandoffOutcome> {
  const before = requestOf(db, worktreeId, requestId);
  if (!before) return handoffError('not_found');
  return withBranchMode(db, worktreeId, before.branch, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    const now = nowOf(deps);
    const row = judgeRequest(db, getHandoffRequest(db, requestId)!, now);
    const closed = agentRefusal(db, row, body.instanceId, now);
    if (closed) return closed;
    changeHandoffRequest(db, row.id, row.version, { state: 'reviewing', agentDoneAt: now }, now);
    return { status: 200, body: readView(db, getHandoffRequest(db, row.id)!, now) };
  });
}

/**
 * `POST …/requests/:rid/proposals/:pid/rebase` `{ ifVersion, fingerprint }` (the screen):
 * a `conflict` proposal the person looked at moves onto the item's current version
 * (§4.5.1). Its revision and fingerprint change, so the old approval no longer
 * matches; it confirms nothing. An item with no such transition now is refused
 * (`state_forbids`: the person can only discard it).
 */
export async function handoffRebase(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  proposalId: string,
  body: Record<string, unknown>,
  deps: HandoffDeps = {}
): Promise<HandoffOutcome> {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  if (!isVersion(body.ifVersion)) return invalidRequest('ifVersion');
  if (typeof body.fingerprint !== 'string' || body.fingerprint.length === 0) return invalidRequest('fingerprint');
  const ifVersion = body.ifVersion;
  const fingerprint = body.fingerprint;
  const before = requestOf(db, worktreeId, requestId);
  if (!before) return handoffError('not_found');
  return withBranchMode(db, worktreeId, before.branch, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    const now = nowOf(deps);
    const row = judgeRequest(db, getHandoffRequest(db, requestId)!, now);
    if (!HANDOFF_OPEN_STATES.includes(row.state)) return closedRefusal(db, row, now);
    if (row.endForced) return handoffError('request_closed', { request: readView(db, row, now).request });
    if (row.version !== ifVersion) return handoffError('version_conflict', { ...readView(db, row, now) });
    if (row.state !== 'reviewing') return handoffError('state_forbids');
    const proposal = getHandoffProposal(db, proposalId);
    if (!proposal || proposal.requestId !== row.id) return handoffError('not_found');
    if (proposal.state !== 'conflict' || proposal.fingerprint !== fingerprint) return handoffError('proposal_changed', { ...readView(db, row, now) });
    const record = proposal.itemId ? getMemRecord(db, proposal.itemId) : null;
    if (!record || !itemOfRequest(target, row, record)) return handoffError('state_forbids');
    const transition = memTransition(record.kind, record.state, proposal.op === 'update' ? 'update' : 'close');
    if (!transition.ok || (proposal.op === 'close' && record.kind === 'decision' && record.state !== 'open')) {
      return handoffError('state_forbids', { itemId: record.id });
    }
    const rebased = rebaseHandoffProposal(db, proposal, record.version, now);
    if (!rebased) return handoffError('proposal_changed');
    changeHandoffRequest(db, row.id, ifVersion, {}, now);
    return { status: 200, body: { ...readView(db, getHandoffRequest(db, row.id)!, now), proposal: proposalView(db, rebased) } };
  });
}
