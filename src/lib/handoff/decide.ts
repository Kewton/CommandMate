/**
 * A person approves or discards the agent's proposals, and the approved ones are
 * confirmed against the item's version (Issue #4227, design `mem-ui-4227.md` §4.5).
 * The one way a proposal becomes an item (PM P3-a (3)).
 *
 * 1. Start (one synchronous transaction): the screen's mark, mode `on`, the request's
 *    version (`ifVersion`), `reviewing` (or, past the agent's window with no `done`,
 *    "go on with what came", §4.4), not forced, the same conversation. Then the request
 *    is `applying` under a new token; a discard is `discarded`; an approval whose
 *    fingerprint is the proposal's now is `approved` under the same token with the
 *    approved fingerprint (the mark). Two decides of the same version: one passes here.
 * 2. Each approved proposal goes to mem's `memWriteFromScreen` as the proposer, with the
 *    request's pin (lifetimes and branch), a fence (the request still `applying` under
 *    this token, the proposal still approved with the same fingerprint, in time, the
 *    same conversation) and the mark, which the service judges by the rows and uses in
 *    the write's transaction. One transaction per proposal: another's failure does not
 *    undo a confirmed one (never rolled back).
 * 3. End: back to `reviewing` when still `applying` under this token.
 *
 * No kill, no send, nothing in the background.
 *
 * @module lib/handoff/decide
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  changeHandoffRequest,
  fingerprintOfRow,
  getHandoffProposal,
  getHandoffRequest,
  HANDOFF_OPEN_STATES,
  setHandoffProposalState,
  type HandoffProposalRow,
  type HandoffRequestRow,
} from '@/lib/db/handoff-db';
import { memWriteFromScreen, type MemScreenWriteInput, type MemServiceDeps } from '@/lib/mem/service';
import { isScreenRequest } from '@/lib/security/screen-request';
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
import type { HandoffDecideResponse, HandoffDecideResult } from './types';

type ScreenRequest = Parameters<typeof isScreenRequest>[0];

export type HandoffDecideDeps = HandoffDeps & MemServiceDeps;

interface Decision {
  proposalId: string;
  fingerprint: string;
  action: 'approve' | 'discard';
}

function readDecisions(raw: unknown): Decision[] | null {
  if (!Array.isArray(raw)) return null;
  const out: Decision[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return null;
    const { proposalId, fingerprint, action } = entry as Record<string, unknown>;
    if (typeof proposalId !== 'string' || typeof fingerprint !== 'string') return null;
    if (action !== 'approve' && action !== 'discard') return null;
    out.push({ proposalId, fingerprint, action });
  }
  return out;
}

type Result = { proposalId: string; result: HandoffDecideResult; code?: string };

/** What mem's service is asked to write for an approved proposal (from the stored row, never from the request). */
function writeInputOf(row: HandoffRequestRow, proposal: HandoffProposalRow, token: string, fence: () => boolean): MemScreenWriteInput {
  const payload = proposal.payload;
  const pin = {
    worktreeIncarnation: row.targetWorktreeIncarnation,
    instanceLifetime: { incarnation: row.instanceIncarnation, onRoster: row.instanceOnRoster },
    membership: { repositoryId: row.repositoryId, branch: row.branch, detached: row.detached },
  };
  const approval = { proposalId: proposal.id, applyToken: token, fingerprint: proposal.fingerprint };
  const body: Record<string, unknown> = { instanceId: row.instanceId };
  if (proposal.op === 'add') {
    Object.assign(body, {
      kind: proposal.kind,
      text: payload.text,
      // A §5.4: one proposal's revision is one item, whatever is resent.
      key: `handoff:${proposal.id}:${proposal.revision}`,
      ...(payload.closeWhen !== undefined ? { closeWhen: payload.closeWhen } : {}),
      ...(payload.evidence !== undefined ? { evidence: payload.evidence } : {}),
      ...(payload.promoteTo !== undefined ? { promoteTo: payload.promoteTo } : {}),
    });
    return { op: 'add', author: 'proposer', body, pin, fence, approval };
  }
  body.ifVersion = proposal.baseVersion;
  if (proposal.op === 'update') {
    if (payload.text !== undefined) body.text = payload.text;
    if (payload.evidence !== undefined) body.evidence = payload.evidence;
    if (payload.closeWhen !== undefined) body.closeWhen = payload.closeWhen;
  } else if (payload.reason !== undefined) {
    body.reason = payload.reason;
  }
  return { op: proposal.op, author: 'proposer', itemId: proposal.itemId ?? undefined, body, pin, fence, approval };
}

/** `POST …/handoff/requests/:rid/decide` `{ ifVersion, decisions: [{ proposalId, fingerprint, action }] }`. */
export async function handoffDecide(
  db: Database.Database,
  request: ScreenRequest,
  worktreeId: string,
  requestId: string,
  body: Record<string, unknown>,
  deps: HandoffDecideDeps = {}
): Promise<HandoffOutcome> {
  if (!isScreenRequest(request)) return handoffError('screen_only');
  if (!isVersion(body.ifVersion)) return invalidRequest('ifVersion');
  const decisions = readDecisions(body.decisions);
  if (!decisions) return invalidRequest('decisions');
  const ifVersion = body.ifVersion;
  const before = requestOf(db, worktreeId, requestId);
  if (!before) return handoffError('not_found');

  const token = randomUUID();
  const results: Result[] = [];
  const approved: HandoffProposalRow[] = [];
  const started = await withBranchMode(db, worktreeId, before.branch, deps, (target) => {
    const refused = modeRefusal(target);
    if (refused) return refused;
    const now = nowOf(deps);
    const row = judgeRequest(db, getHandoffRequest(db, requestId)!, now);
    if (!HANDOFF_OPEN_STATES.includes(row.state)) return closedRefusal(db, row, now);
    if (row.version !== ifVersion) return handoffError('version_conflict', { ...readView(db, row, now) });
    if (row.endForced) return handoffError('request_closed', { request: readView(db, row, now).request });
    const goOn = row.state === 'awaiting_agent' && now >= row.agentDeadlineAt;
    if (row.state !== 'reviewing' && !goOn) return handoffError('state_forbids', { request: readView(db, row, now).request });
    if (!changeHandoffRequest(db, row.id, ifVersion, { state: 'applying', applyToken: token }, now)) {
      return handoffError('version_conflict', { ...readView(db, getHandoffRequest(db, row.id)!, now) });
    }
    for (const decision of decisions) {
      const proposal = getHandoffProposal(db, decision.proposalId);
      if (!proposal || proposal.requestId !== row.id) {
        results.push({ proposalId: decision.proposalId, result: 'proposal_changed' });
        continue;
      }
      if (decision.action === 'discard') {
        const done = setHandoffProposalState(db, proposal.id, ['proposed', 'conflict'], { state: 'discarded', reason: 'discarded' }, now);
        results.push({ proposalId: proposal.id, result: done ? 'discarded' : 'proposal_changed' });
        continue;
      }
      // The approval is of what the person saw: the fingerprint is the proposal's, and its columns still give it.
      const seen = proposal.state === 'proposed' && proposal.fingerprint === decision.fingerprint && fingerprintOfRow(proposal) === decision.fingerprint;
      if (!seen) {
        results.push({ proposalId: proposal.id, result: 'proposal_changed' });
        continue;
      }
      setHandoffProposalState(db, proposal.id, ['proposed'], { state: 'approved', applyToken: token, approvedFingerprint: decision.fingerprint }, now);
      approved.push(getHandoffProposal(db, proposal.id)!);
    }
    return { status: 200, body: null };
  });
  if (started.status !== 200) return started;

  for (const proposal of approved) {
    const fence = (): boolean => {
      const now = nowOf(deps);
      const row = getHandoffRequest(db, requestId);
      const current = getHandoffProposal(db, proposal.id);
      if (!row || !current) return false;
      if (row.state !== 'applying' || row.applyToken !== token || now >= row.expiresAt) return false;
      if (current.state !== 'approved' || current.applyToken !== token) return false;
      if (current.revision !== proposal.revision || current.fingerprint !== proposal.fingerprint) return false;
      return sameConversation(db, row);
    };
    const row = getHandoffRequest(db, requestId)!;
    let code: string | undefined;
    let ok = false;
    try {
      const outcome = await memWriteFromScreen(db, request, worktreeId, writeInputOf(row, proposal, token, fence), deps);
      ok = outcome.status < 300;
      code = ok ? undefined : ((outcome.body as { code?: string }).code ?? String(outcome.status));
    } catch {
      code = 'db_error';
    }
    if (ok) {
      results.push({ proposalId: proposal.id, result: 'applied' });
      continue;
    }
    results.push(settleRefused(db, requestId, proposal, token, code ?? 'failed', deps));
  }

  const now = nowOf(deps);
  return db.transaction((): HandoffOutcome => {
    const row = getHandoffRequest(db, requestId)!;
    if (row.state === 'applying' && row.applyToken === token) {
      changeHandoffRequest(db, row.id, null, { state: 'reviewing', applyToken: null }, now);
    }
    const answer: HandoffDecideResponse = { ...readView(db, judgeRequest(db, getHandoffRequest(db, requestId)!, now), now), results };
    return { status: 200, body: answer };
  })();
}

/**
 * What a refused confirmation leaves on the proposal (§4.5 2): a version conflict or a
 * transition the item no longer has → `conflict`; a moved branch, a gone mark or any
 * other refusal → `failed`; a fence (cancelled, forced, expired, a changed session) →
 * whatever ended the request already wrote, or `expired` when the session changed.
 */
function settleRefused(
  db: Database.Database,
  requestId: string,
  proposal: HandoffProposalRow,
  token: string,
  code: string,
  deps: HandoffDeps
): Result {
  const now = nowOf(deps);
  return db.transaction((): Result => {
    if (code === 'fenced') {
      judgeRequest(db, getHandoffRequest(db, requestId)!, now);
      setHandoffProposalState(db, proposal.id, ['approved'], { state: 'expired', reason: 'fenced' }, now);
      const after = getHandoffProposal(db, proposal.id)!;
      return { proposalId: proposal.id, result: after.state === 'discarded' ? 'discarded' : 'expired', code: after.stateReason ?? code };
    }
    const conflict = code === 'version_conflict' || code === 'state_forbids';
    const current = getHandoffProposal(db, proposal.id);
    if (current?.state === 'approved' && current.applyToken === token) {
      setHandoffProposalState(db, proposal.id, ['approved'], { state: conflict ? 'conflict' : 'failed', reason: code }, now);
    }
    return { proposalId: proposal.id, result: conflict ? 'conflict' : 'failed', code };
  })();
}
