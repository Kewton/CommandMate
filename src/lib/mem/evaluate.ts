/**
 * The evaluation of the close conditions of a branch (Issue #4222, design
 * `docs/design/mem-close-when-4222.md` §1・§3.2・§4・§5).
 *
 * The one entrance: `mem list`, `mem check`, the brief (#4223) and the screen's
 * preview (#4227) all call {@link evaluateMemConditions}. It runs inside the call and
 * leaves nothing behind (§7): no timer, no cache, no child after the last caller.
 *
 * 1. Synchronously: the items and their `(id, version, close_when)`, fixed.
 * 2. The queries, through one {@link QueryPlan} (budget, deadline, merge, sharing).
 * 3. Synchronously, one transaction per met item: the mode, the version and the
 *    worktree asked again, then the close, its record and its notice
 *    (`lib/db/mem-close-db.ts`).
 *
 * Unknown never closes. A decision met before it is promoted stays open, marked
 * `unreflected` (§5), and nothing is written for it.
 *
 * @module lib/mem/evaluate
 */

import { existsSync } from 'fs';
import type Database from 'better-sqlite3';
import { getRepositoryById } from '@/lib/db/db-repository';
import { closeItemByCondition, readScheduleRunStatus } from '@/lib/db/mem-close-db';
import { listMem, type MemScope } from '@/lib/db/mem-db';
import { getRelayById } from '@/lib/db/relay-db-base';
import { getTask } from '@/lib/db/tasks-db';
import { getVerificationRun } from '@/lib/db/verification-db';
import type {
  MemCloseWhen,
  MemCloseWhenType,
  MemConditionView,
  MemEvalTrigger,
  MemKind,
  MemState,
  MemUnknownReason,
} from '@/types/mem';
import { parseOriginUrl, parseSessionId, readStoredCloseWhen } from './close-when';
import {
  compareCreation,
  decideAt,
  decideBranchDeleted,
  decideIssue,
  decidePr,
  decideRelay,
  decideSchedule,
  decideTask,
  decideVerify,
  decideWorktree,
  met,
  notMet,
  unknown,
  type BranchIdentity,
  type ConditionAnswer,
} from './condition-evaluators';
import { isAncestor, listRemoteHeads, readLocalRef, readOrigin, readRefCreatedSeconds } from './git-query';
import { ghApi, hostAllowed, repoPath } from './github-query';
import { worktreeIncarnationAlive } from './incarnation';
import { DEFAULT_QUERY_LIMITS, defaultMemExec, QueryPlan, type MemExec, type QueryLimits } from './query-plan';
import type { MemTarget, MemTargetResolved } from './target';
import { memTransition } from './transitions';

/** §1.1: the whole evaluation's deadline for `list` and `check`; the brief and the preview pass theirs. */
export const MEM_EVAL_DEADLINE_MS: Readonly<Record<MemEvalTrigger, number>> = {
  list: 10_000,
  check: 10_000,
  brief: 3_000,
  preview: 3_000,
};

export interface MemEvalDeps {
  exec?: MemExec;
  now?: () => number;
  pathExists?: (path: string) => boolean;
}

export interface MemEvalContext {
  trigger: MemEvalTrigger;
  /** Who asked (recorded as the trigger, never as the owner). */
  caller?: { worktreeId: string; instanceId: string | null } | null;
  /**
   * Whether the worktree the request was read for is still the same lifetime, asked
   * in each close's transaction (a delete and re-creation under the same id and path
   * during the queries refuses the close). null when asked through a repository.
   */
  alive?: (() => boolean) | null;
  deadlineMs?: number;
  limits?: Partial<QueryLimits>;
  deps?: MemEvalDeps;
}

export interface MemEvalItemResult {
  itemId: string;
  kind: MemKind;
  type: MemCloseWhenType | null;
  condition: MemConditionView;
}

export interface MemEvalReport {
  /** false: the mode is not `on` (or the target failed): nothing was asked or written. */
  evaluated: boolean;
  results: MemEvalItemResult[];
  /** The query keys asked, once each (tests, logs). */
  asked: string[];
}

interface Candidate {
  id: string;
  kind: MemKind;
  state: MemState;
  version: number;
  closeWhenJson: string;
  condition: MemCloseWhen | null;
  repositoryId: string;
  branch: string | null;
  createdAt: number;
}

const NOT_EVALUATED: ReadonlySet<string> = new Set(['manual', 'replaced']);

function scopeOfTarget(target: MemTargetResolved): MemScope {
  return {
    storageRepositoryId: target.storageRepositoryId,
    readRepositoryIds: target.readRepositoryIds,
    branch: target.detached ? null : target.branch,
    worktreeId: target.worktree?.id ?? null,
  };
}

/** The items of the target whose condition is evaluated, oldest first (§1.1). */
function candidatesOf(db: Database.Database, target: MemTargetResolved): Candidate[] {
  const listed = listMem(db, scopeOfTarget(target));
  const records = [...listed.items, ...listed.now.map((slot) => slot.record)];
  const out: Candidate[] = [];
  for (const record of records) {
    if (record.state === 'closed' || record.closeWhen === null) continue;
    const condition = readStoredCloseWhen(record.closeWhen);
    if (condition && NOT_EVALUATED.has(condition.type)) continue;
    out.push({
      id: record.id,
      kind: record.kind,
      state: record.state,
      version: record.version,
      closeWhenJson: record.closeWhen,
      condition,
      repositoryId: record.owner.repositoryId,
      branch: record.owner.branch,
      createdAt: record.createdAt,
    });
  }
  // Stable: a tie keeps the store's order (created_at, rowid), so the same input asks in the same order.
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

interface Env {
  db: Database.Database;
  plan: QueryPlan;
  now: () => number;
  pathExists: (path: string) => boolean;
}

function rootOf(env: Env, repositoryId: string): string | null {
  const repository = getRepositoryById(env.db, repositoryId);
  if (!repository || !env.pathExists(repository.path)) return null;
  return repository.path;
}

async function originHostOf(env: Env, repositoryId: string): Promise<string | null> {
  const root = rootOf(env, repositoryId);
  if (!root) return null;
  return parseOriginUrl(await readOrigin(env.plan, repositoryId, root))?.host ?? null;
}

async function evaluateIssueLike(
  env: Env,
  candidate: Candidate,
  condition: Extract<MemCloseWhen, { type: 'issue' | 'pr' }>
): Promise<ConditionAnswer> {
  const path = repoPath(condition.owner, condition.repo);
  if (!path) return unknown('unexpected_response');
  const originHost = condition.host.toLowerCase() === 'github.com' ? null : await originHostOf(env, candidate.repositoryId);
  if (!hostAllowed(condition.host, originHost)) return unknown('host_not_allowed');
  const host = condition.host.toLowerCase();
  const ident = `${host}/${condition.owner.toLowerCase()}/${condition.repo.toLowerCase()}#${condition.number}`;
  if (condition.type === 'issue') {
    const answer = await ghApi(env.plan, `gh-issue:${ident}`, host, `${path}/issues/${condition.number}`);
    return answer.ok ? decideIssue(answer.json) : unknown(answer.reason);
  }
  const answer = await ghApi(env.plan, `gh-pr:${ident}`, host, `${path}/pulls/${condition.number}`);
  return answer.ok ? decidePr(answer.json, condition.state) : unknown(answer.reason);
}

type BranchCondition = Extract<MemCloseWhen, { type: 'branch' }>;

interface BranchView {
  identity: BranchIdentity;
  heads: Map<string, string> | null;
  root: string;
}

async function branchView(env: Env, condition: BranchCondition, itemCreatedAt: number): Promise<BranchView | ConditionAnswer> {
  const root = rootOf(env, condition.repositoryId);
  if (!root) return unknown('repository_unavailable');
  const baseline = condition.tipAtCreate;
  const failed = (reason: MemUnknownReason): BranchView => ({ identity: { kind: 'failed', reason }, heads: null, root });
  if (condition.scope === 'remote') {
    const listed = await listRemoteHeads(env.plan, condition.repositoryId, root);
    if (!listed.ok) return failed(listed.reason);
    const tip = listed.heads.get(condition.name);
    const view = (identity: BranchIdentity): BranchView => ({ identity, heads: listed.heads, root });
    if (!tip) return view({ kind: 'gone' });
    if (!baseline) return view({ kind: 'present-no-baseline' });
    const ancestry = await isAncestor(env.plan, condition.repositoryId, root, baseline, tip);
    if (!ancestry.ok) return view({ kind: 'failed', reason: ancestry.reason });
    return view(ancestry.ancestor ? { kind: 'same', tip } : { kind: 'diverged' });
  }
  const local = await readLocalRef(env.plan, condition.repositoryId, root, `refs/heads/${condition.name}`);
  if (!local.ok) return failed(local.reason);
  const view = (identity: BranchIdentity): BranchView => ({ identity, heads: null, root });
  if (local.tip === null) return view({ kind: 'gone' });
  // P2-1: an empty baseline is never read as a re-creation or a divergence.
  if (!baseline) return view({ kind: 'present-no-baseline' });
  const created = await readRefCreatedSeconds(env.plan, condition.repositoryId, root, condition.name);
  if (!created.ok) return failed(created.reason);
  if (created.seconds !== null) {
    const order = compareCreation(created.seconds, itemCreatedAt);
    if (order === 'after') return view({ kind: 'recreated' });
    if (order === 'same-second') return view({ kind: 'order-uncertain' });
  }
  const ancestry = await isAncestor(env.plan, condition.repositoryId, root, baseline, local.tip);
  if (!ancestry.ok) return view({ kind: 'failed', reason: ancestry.reason });
  return view(ancestry.ancestor ? { kind: 'same', tip: local.tip } : { kind: 'diverged' });
}

const isAnswer = (value: BranchView | ConditionAnswer): value is ConditionAnswer => 'result' in value;

interface PullSummary {
  mergedAt: number | null;
  headSha: string | null;
}

function readPulls(json: unknown): PullSummary[] | null {
  if (!Array.isArray(json)) return null;
  return json.map((entry) => {
    const pr = entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : {};
    const head = pr.head && typeof pr.head === 'object' ? (pr.head as Record<string, unknown>) : {};
    const mergedAt = typeof pr.merged_at === 'string' ? Date.parse(pr.merged_at) : NaN;
    return {
      mergedAt: Number.isFinite(mergedAt) ? mergedAt : null,
      headSha: typeof head.sha === 'string' && /^[0-9a-f]{40}$/.test(head.sha) ? head.sha : null,
    };
  });
}

/** §1.4 step 4: a squash / rebase merge, or a merge whose branch was deleted after, seen on GitHub. */
async function mergedByPullRequest(
  env: Env,
  condition: BranchCondition,
  view: BranchView,
  head: string | null,
  itemCreatedAt: number
): Promise<{ ok: true; merged: boolean } | { ok: false; reason: MemUnknownReason }> {
  const origin = parseOriginUrl(await readOrigin(env.plan, condition.repositoryId, view.root));
  if (!origin) return { ok: false, reason: 'repository_unavailable' };
  const path = repoPath(origin.owner, origin.repo);
  if (!path || !condition.into) return { ok: false, reason: 'unexpected_response' };
  const host = origin.host.toLowerCase();
  const query = `state=closed&base=${encodeURIComponent(condition.into)}&head=${encodeURIComponent(`${origin.owner}:${condition.name}`)}&per_page=20`;
  const key = `gh-pr-head:${host}/${origin.owner.toLowerCase()}/${origin.repo.toLowerCase()}:${condition.name}:${condition.into}`;
  const answer = await ghApi(env.plan, key, host, `${path}/pulls?${query}`);
  if (!answer.ok) return answer;
  const pulls = readPulls(answer.json);
  if (!pulls) return { ok: false, reason: 'unexpected_response' };
  let failure: MemUnknownReason | null = null;
  for (const pull of pulls) {
    // P2-2: merged after the item was written, from a head that has the item's commits, and
    // (while the branch is there) the head it has now.
    if (pull.mergedAt === null || pull.mergedAt <= itemCreatedAt) continue;
    if (!pull.headSha || pull.headSha === condition.tipAtCreate) continue;
    if (head !== null && pull.headSha !== head) continue;
    const local = await isAncestor(env.plan, condition.repositoryId, view.root, condition.tipAtCreate, pull.headSha);
    if (local.ok) {
      if (local.ancestor) return { ok: true, merged: true };
      continue;
    }
    if (local.reason !== 'objects_missing') {
      failure = local.reason;
      continue;
    }
    const compare = await ghApi(
      env.plan,
      `gh-compare:${host}/${origin.owner.toLowerCase()}/${origin.repo.toLowerCase()}:${condition.tipAtCreate}:${pull.headSha}`,
      host,
      `${path}/compare/${condition.tipAtCreate}...${pull.headSha}`
    );
    if (!compare.ok) {
      failure = compare.reason;
      continue;
    }
    const status = compare.json && typeof compare.json === 'object' ? (compare.json as Record<string, unknown>).status : null;
    if (status === 'ahead') return { ok: true, merged: true };
  }
  return failure ? { ok: false, reason: failure } : { ok: true, merged: false };
}

async function evaluateBranchMerged(env: Env, condition: BranchCondition, view: BranchView, itemCreatedAt: number): Promise<ConditionAnswer> {
  const facts = { identity: view.identity.kind };
  const remote = condition.scope === 'remote';
  const viaPull = async (head: string | null, earlier: MemUnknownReason | null): Promise<ConditionAnswer> => {
    const pulled = await mergedByPullRequest(env, condition, view, head, itemCreatedAt);
    if (pulled.ok && pulled.merged) return met('branch-merged-pr', 'success', facts);
    if (!pulled.ok) return unknown(earlier ?? pulled.reason, facts);
    if (earlier) return unknown(earlier, facts);
    return head !== null ? notMet('not-merged', facts) : unknown('branch-gone-unmerged-unknown', facts);
  };
  switch (view.identity.kind) {
    case 'failed':
      return unknown(view.identity.reason, facts);
    case 'present-no-baseline':
      return unknown('schema_unknown', facts);
    case 'order-uncertain':
      return unknown('branch-order-uncertain', facts);
    case 'diverged':
      return unknown('branch-diverged', facts);
    case 'recreated':
      return unknown('branch-gone-unmerged-unknown', facts);
    case 'gone':
      return remote ? viaPull(null, null) : unknown('branch-gone-unmerged-unknown', facts);
    case 'same': {
      const head = view.identity.tip;
      if (head === condition.tipAtCreate) return notMet('no-new-commits', facts);
      if (!condition.into) return unknown('schema_unknown', facts);
      let intoTip: string | null;
      if (remote) {
        intoTip = view.heads?.get(condition.into) ?? null;
      } else {
        const into = await readLocalRef(env.plan, condition.repositoryId, view.root, `refs/heads/${condition.into}`);
        if (!into.ok) return unknown(into.reason, facts);
        intoTip = into.tip;
      }
      if (intoTip === null) return remote ? viaPull(head, null) : notMet('not-merged', facts);
      const contained = await isAncestor(env.plan, condition.repositoryId, view.root, head, intoTip);
      if (contained.ok && contained.ancestor) return met('branch-merged', 'success', facts);
      if (remote) return viaPull(head, contained.ok || contained.reason === 'objects_missing' ? null : contained.reason);
      if (!contained.ok) return unknown(contained.reason, facts);
      return notMet('not-merged', facts);
    }
  }
}

async function evaluateOne(env: Env, candidate: Candidate): Promise<ConditionAnswer> {
  const condition = candidate.condition;
  if (!condition) return unknown('schema_unknown');
  switch (condition.type) {
    case 'issue':
    case 'pr':
      return evaluateIssueLike(env, candidate, condition);
    case 'branch': {
      const view = await branchView(env, condition, candidate.createdAt);
      if (isAnswer(view)) return view;
      return condition.event === 'deleted'
        ? decideBranchDeleted(view.identity)
        : evaluateBranchMerged(env, condition, view, candidate.createdAt);
    }
    case 'relay':
      return decideRelay(getRelayById(env.db, condition.relayId));
    case 'worktree':
      return decideWorktree(condition.worktreeIncarnation, (incarnation) => worktreeIncarnationAlive(env.db, incarnation));
    case 'session': {
      const session = parseSessionId(condition.sessionId);
      if (!session) return unknown('session_kind_unknown');
      if (session.kind === 'task') return decideTask(getTask(env.db, session.id)?.status ?? null);
      if (session.kind === 'verify') return decideVerify(getVerificationRun(env.db, Number(session.id))?.status ?? null);
      return decideSchedule(readScheduleRunStatus(env.db, session.id));
    }
    case 'at':
      return decideAt(env.now(), condition.epochMs);
    default:
      return unknown('schema_unknown');
  }
}

/**
 * Evaluate the conditions of the target's branch, and close what is met (§3.2).
 * Asks nothing and writes nothing unless the target is resolved with mode `on` (§4).
 */
export async function evaluateMemConditions(db: Database.Database, target: MemTarget, ctx: MemEvalContext): Promise<MemEvalReport> {
  if (!target.ok || target.mode !== 'on') return { evaluated: false, results: [], asked: [] };
  const now = ctx.deps?.now ?? Date.now;
  const started = now();
  const plan = new QueryPlan(
    ctx.deps?.exec ?? defaultMemExec,
    now,
    started + (ctx.deadlineMs ?? MEM_EVAL_DEADLINE_MS[ctx.trigger]),
    { ...DEFAULT_QUERY_LIMITS, ...ctx.limits }
  );
  const env: Env = { db, plan, now, pathExists: ctx.deps?.pathExists ?? existsSync };
  const candidates = candidatesOf(db, target);
  const answers = await Promise.all(
    candidates.map((candidate) =>
      evaluateOne(env, candidate).catch((): ConditionAnswer => unknown('unexpected_response'))
    )
  );

  const evaluatedAt = new Date(now()).toISOString();
  const results: MemEvalItemResult[] = candidates.map((candidate, index) => {
    const answer = answers[index];
    const condition: MemConditionView = { result: answer.result, reason: answer.reason, evaluatedAt, closed: false };
    if (answer.outcome) condition.outcome = answer.outcome;
    if (answer.result === 'met') {
      if (!memTransition(candidate.kind, candidate.state, 'condition').ok) {
        if (candidate.kind === 'decision') condition.unreflected = true;
      } else if (candidate.condition) {
        condition.closed = closeItemByCondition(db, {
          item: {
            id: candidate.id,
            version: candidate.version,
            closeWhen: candidate.closeWhenJson,
            type: candidate.condition.type,
            repositoryId: candidate.repositoryId,
            branch: candidate.branch,
          },
          answer: {
            endReason: answer.reason,
            outcome: answer.outcome ?? 'unknown',
            observation: { source: candidate.condition.type, observedAt: evaluatedAt, facts: answer.facts },
          },
          trigger: ctx.trigger,
          triggeredBy: ctx.caller ?? null,
          modeRoots: target.members.map((root) => root.id),
          alive: ctx.alive ?? null,
          now: now(),
        });
      }
    }
    return { itemId: candidate.id, kind: candidate.kind, type: candidate.condition?.type ?? null, condition };
  });
  return { evaluated: true, results, asked: [...plan.asked] };
}
