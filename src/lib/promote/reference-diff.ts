/**
 * A decision's diff drawn for reading (Issue #4355, design `docs/design/mem-decisions-ux-4355.md`
 * §3.4.2・§4.2): what `commandmate mem decisions <itemId>` shows. It is a reference, never
 * what a person approves — approving stays on the screen (#4225 D9), which makes its own
 * preview.
 *
 * The conditions of a read without the screen's mark (design §3.4.2, 1〜4):
 * 1. the item belongs to `:id`'s roots (the same git), and so does the worktree named;
 * 2. the whole item is checked against the current rules first (`findWithheld`: the text,
 *    the quote, the evidence, the destination and the close note) and nothing of it is
 *    answered on a match; the drawn body goes through `renderPromoteBody`'s check as well;
 * 3. the free fields go out as JSON strings only (the CLI escapes the terminal's controls);
 * 4. nothing is written: no preview row, no incarnation, no prune or sweep, no `gh`, no
 *    file — git is only asked for the worktree's HEAD (a read).
 *
 * @module lib/promote/reference-diff
 */

import type Database from 'better-sqlite3';
import { getMemRecord } from '@/lib/db/mem-db';
import { getRepositoryById, type Repository } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';
import {
  AgentRoleTargetNotFoundError,
  MembershipUnsettledError,
  withSettledRepositoryMembership,
  type RoleRepositoryMembership,
} from '@/lib/agent-roles/resolve';
import type { WorktreeHeadObservation } from '@/lib/mem/git-observe';
import { findWithheld, type MemRecord } from '@/lib/mem/present';
import type { MemOutcome, MemServiceDeps } from '@/lib/mem/service';
import { decideMemTarget } from '@/lib/mem/target';
import type { Worktree } from '@/types/models';
import { checkDocPath, parsePromoteTo } from './destination';
import {
  PROMOTE_EFFECTS,
  PROMOTE_REFERENCE_NOTICE,
  type PromoteEffect,
  type PromoteReferenceDestination,
  type PromoteReferenceDiffView,
} from './model';
import { renderPromoteBody } from './render';

export interface PromoteReferenceDiffQuery {
  worktreeId?: string | null;
  effect?: string | null;
}

export interface PromoteReferenceDiffDeps {
  now?: () => number;
  /** What the membership asks git (and the worktree's HEAD). */
  mem?: MemServiceDeps;
}

const MESSAGES = {
  not_found: 'Not found',
  invalid_request: 'The request is not valid',
  secret_like: 'A field of the item looks like it contains a secret; nothing of it is shown',
} as const;

type DiffErrorCode = keyof typeof MESSAGES;
const STATUS: Record<DiffErrorCode, number> = { not_found: 404, invalid_request: 400, secret_like: 422 };

/** A refusal: the code and at most the name of a field, never a value of the item. */
function diffError(code: DiffErrorCode, field?: string): MemOutcome {
  return { status: STATUS[code], body: { ok: false, code, message: MESSAGES[code], ...(field ? { field } : {}) } };
}

/** Every root judged to be this repository (disabled ones included), as the list reads them. */
const rootsOf = (membership: RoleRepositoryMembership): Repository[] =>
  membership.candidates && membership.candidates.length > 0 ? membership.candidates : membership.members;

async function observeHead(path: string, deps: PromoteReferenceDiffDeps): Promise<WorktreeHeadObservation> {
  if (deps.mem?.observe) return deps.mem.observe(path);
  return (await import('@/lib/mem/git-observe')).observeWorktreeHead(path);
}

/** Where the record would go, as far as it can be told without writing or asking gh. */
async function destinationOf(record: MemRecord, worktree: Worktree | null, deps: PromoteReferenceDiffDeps): Promise<PromoteReferenceDestination | null> {
  const parsed = parsePromoteTo(record.promoteTo);
  if (!parsed) return null;
  if (parsed.kind === 'issue') {
    // A comment needs no worktree; the origin is not asked here (a reference, not a preview).
    return { resolved: true, kind: 'issue_comment', ref: parsed.ref, number: parsed.number, target: parsed.target };
  }
  // A document's path and HEAD are the worktree's: never guessed when none is named (design §3.4.2).
  if (!worktree) return { resolved: false, kind: 'worktree_doc', reason: 'worktree_required' };
  const head = await observeHead(worktree.path, deps);
  if (!head.known || head.detached) return { resolved: false, kind: 'worktree_doc', reason: 'branch_unresolved' };
  if (head.branch !== record.owner.branch) return { resolved: false, kind: 'worktree_doc', reason: 'branch_changed' };
  const checked = checkDocPath(worktree.path, parsed.path);
  if (!checked.ok) return { resolved: false, kind: 'worktree_doc', reason: 'invalid_destination', detail: checked.code };
  return { resolved: true, kind: 'worktree_doc', worktreeId: worktree.id, path: checked.rel, exists: checked.exists, headBranch: head.branch };
}

/** `GET /api/repositories/:id/mem/decisions/:itemId/diff?worktreeId=&effect=` — read only. */
export async function promoteReferenceDiff(
  db: Database.Database,
  repositoryId: string,
  itemId: string,
  query: PromoteReferenceDiffQuery,
  deps: PromoteReferenceDiffDeps = {}
): Promise<MemOutcome> {
  if (!getRepositoryById(db, repositoryId)) return diffError('not_found');
  const record = getMemRecord(db, itemId);
  if (!record || record.kind !== 'decision') return diffError('not_found');

  let settled: { mode: string; roots: Repository[] };
  try {
    settled = await withSettledRepositoryMembership(db, repositoryId, deps.mem ?? {}, (_repository, membership) => {
      const target = decideMemTarget(db, membership, record.owner.branch, { via: 'repository', worktree: null, detached: false, head: null });
      return { mode: target.ok ? target.mode : target.code === 'ambiguous' ? 'ambiguous' : target.code, roots: rootsOf(membership) };
    });
  } catch (error) {
    if (error instanceof AgentRoleTargetNotFoundError || error instanceof MembershipUnsettledError) return diffError('not_found');
    throw error;
  }
  // 1. Another repository's item is not read through this one's id.
  if (!settled.roots.some((root) => root.id === record.owner.repositoryId)) return diffError('not_found');

  let worktree: Worktree | null = null;
  if (typeof query.worktreeId === 'string' && query.worktreeId.length > 0) {
    const id = resolveWorktreeIdWithAlias(db, query.worktreeId);
    worktree = id ? getWorktreeById(db, id) : null;
    if (!worktree || !settled.roots.some((root) => root.path === worktree!.repositoryPath)) return diffError('not_found');
  }

  const effect = (query.effect ?? 'spec') as PromoteEffect;
  if (!PROMOTE_EFFECTS.includes(effect)) return diffError('invalid_request', 'effect');

  // 2. The whole item, before anything of it is drawn: one match withholds all of it.
  const withheld = findWithheld(record);
  if (withheld) return diffError('secret_like', withheld.field);

  const now = deps.now?.() ?? Date.now();
  // The quote is the agent's (unconfirmed): a person's confirmation is made on the screen only.
  const quote = record.quote !== null && record.quoteAt !== null ? { text: record.quote, origin: 'agent' as const, at: record.quoteAt } : null;
  const rendered = renderPromoteBody({
    operationId: '',
    itemId: record.id,
    itemVersion: record.version,
    branch: record.owner.branch,
    effect,
    authorInstanceId: record.owner.instanceId,
    authorCreatedAt: record.createdAt,
    createdAt: now,
    text: record.text,
    quote,
  });
  if (!rendered.ok) return diffError('secret_like', 'body');

  const body: PromoteReferenceDiffView = {
    ok: true,
    reference: true,
    approvable: false,
    notice: PROMOTE_REFERENCE_NOTICE,
    repositoryId,
    item: { id: record.id, version: record.version, state: record.state, branch: record.owner.branch },
    mode: settled.mode,
    effect,
    quoteOrigin: quote ? 'agent' : 'none',
    destination: await destinationOf(record, worktree, deps),
    body: rendered.body,
    bodySha256: rendered.bodySha256,
    invisibleReplaced: rendered.invisibleReplaced,
    drawnAt: new Date(now).toISOString(),
  };
  return { status: 200, body };
}
