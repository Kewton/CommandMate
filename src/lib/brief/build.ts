/**
 * `buildBrief`: the one place a brief is made (Issue #4223, design §5). The route
 * (`commandmate brief`) and the provider (D1's port) both call it.
 *
 *  1. Before the first await: the worktree, its roster, the worktree's lifetime
 *     (#4222's `fixMemEvalLifetime`) and the instance's lifetime (D1's rule).
 *  2. The membership and mode (`withMemTarget`), waited for within the deadline.
 *  3. `on` only: #4222's evaluation of the conditions (it may close what is met).
 *  4. The sources, in parallel, each within what is left; a slow or failing one is a
 *     "could not be read" row and the others still answer.
 *  5. The same membership, worktree and instance lifetime asked again synchronously
 *     before anything is drawn: a change while waiting throws.
 *
 * No model and no generator is called (D1): only fixed words and stored values.
 *
 * @module lib/brief/build
 */

import type Database from 'better-sqlite3';
import { getAllRepositories } from '@/lib/db/db-repository';
import { decideRootMode } from '@/lib/db/mem-db';
import { isSameInstanceLifetime, readInstanceLifetime, type InstanceLifetime } from '@/lib/db/session-brief-db';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { evaluateMemConditions, fixMemEvalLifetime, type MemEvalDeps, type MemEvalLifetime } from '@/lib/mem/evaluate';
import { getWorktreeIncarnation } from '@/lib/mem/incarnation';
import { captureMemRecipient } from '@/lib/mem/notices';
import { withMemTarget, type MemTarget, type MemTargetDeps, type MemTargetResolved } from '@/lib/mem/target';
import type { BriefRequest } from '@/lib/session/brief-provider';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import type { MemConditionView, MemMode } from '@/types/mem';
import {
  BRIEF_FIXED_LIMITS,
  BRIEF_SOURCE_IDS,
  BRIEF_TEXT_FIXED_LINES,
  type BriefSourceId,
  type BriefSourceReport,
} from '@/types/brief';
import { BriefDeadlineExpiredError, createBriefDeadline, withinMs } from './deadline';
import type { BriefItem, BriefModel } from './model';
import { rankBriefItems } from './rank';
import { fixedId, sanitizeBranch } from './sanitize';
import {
  BRIEF_DERIVED_SOURCES,
  BRIEF_SOURCE_READERS,
  statusRowItem,
  type BriefSourceAnswer,
  type BriefSourceContext,
  type BriefSourceReader,
} from './sources';

/** The membership, the mode or a lifetime changed while the build waited (design §5.4). */
export class BriefMembershipChangedError extends Error {
  constructor(
    readonly why: 'membership' | 'mode' | 'worktree_lifetime' | 'instance_lifetime',
    /** The mode read when it was found; `off` makes the CLI answer exit 50. */
    readonly modeNow: MemMode | null = null
  ) {
    super(`brief membership changed (${why})`);
  }
}

/** How the deadline is shared out (design §5.5). */
export interface BriefTimeBudget {
  totalMs: number;
  /** What the membership wait leaves for the rest. */
  membershipReserveMs: number;
  /** Below this after the membership, the conditions are not evaluated. */
  evaluateMinMs: number;
  evaluateCapMs: number;
  evaluateReserveMs: number;
  sourceCapMs: number;
  sourceReserveMs: number;
}

export const PROVIDER_TIME_BUDGET: BriefTimeBudget = {
  totalMs: 1_700,
  membershipReserveMs: 300,
  evaluateMinMs: 500,
  evaluateCapMs: 1_200,
  evaluateReserveMs: 400,
  sourceCapMs: Number.POSITIVE_INFINITY,
  sourceReserveMs: 100,
};

export const CLI_TIME_BUDGET: BriefTimeBudget = {
  totalMs: 8_000,
  membershipReserveMs: 2_500,
  evaluateMinMs: 500,
  evaluateCapMs: 3_000,
  evaluateReserveMs: 2_500,
  sourceCapMs: 2_000,
  sourceReserveMs: 300,
};

export interface BriefBuildDeps {
  now?: () => number;
  /** `withMemTarget`'s probes (git, paths) for tests. */
  target?: MemTargetDeps;
  /** #4222's evaluation's exec and clock, for tests. */
  evaluation?: MemEvalDeps;
  /** Replace a source's reader (tests). */
  readers?: Partial<Record<BriefSourceId, BriefSourceReader>>;
  /** Replace the time budget of the entrance (tests). */
  time?: BriefTimeBudget;
}

export interface BuildBriefInput {
  worktreeId: string;
  instanceId: string;
  time: BriefTimeBudget;
  /** The provider's request: its membership and instance incarnation are checked (design §5.4). */
  request?: BriefRequest;
  /** The provider's line budget: below the fixed lines nothing is built (G3). */
  maxLines?: number;
  /** The CLI answers a membership wait past the deadline as `ambiguous`; the provider throws. */
  onMembershipTimeout: 'ambiguous' | 'throw';
}

export type BriefRefusal = {
  kind: 'refused';
  code: 'not_found' | 'instance_not_found' | 'not_registered' | 'ambiguous' | 'branch_unresolved' | 'disabled';
  reason?: string;
  mode?: MemMode;
};

export type BuildBriefOutcome =
  | { kind: 'built'; model: BriefModel; target: MemTargetResolved; recipient: BriefSourceContext['recipient']; membershipKey: string }
  | { kind: 'empty'; mode: Exclude<MemMode, 'off'> }
  | BriefRefusal;

/** The membership as D1 keys it (without the features, which C does not read). */
export function briefMembershipKey(membership: {
  repositoryId: string;
  readRepositoryIds: readonly string[];
  branch: string | null;
  detached: boolean;
  mode: MemMode;
}): string {
  return JSON.stringify([membership.repositoryId, [...membership.readRepositoryIds].sort(), membership.branch, membership.detached, membership.mode]);
}

const keyOfTarget = (target: MemTargetResolved): string =>
  briefMembershipKey({
    repositoryId: target.storageRepositoryId,
    readRepositoryIds: target.readRepositoryIds,
    branch: target.branch,
    detached: target.detached,
    mode: target.mode,
  });

const MEMBERSHIP_TIMED_OUT: unique symbol = Symbol('membership-timed-out');
const SOURCE_TIMED_OUT: unique symbol = Symbol('source-timed-out');

async function readOne(
  id: BriefSourceId,
  reader: BriefSourceReader,
  ctx: BriefSourceContext,
  ms: number
): Promise<BriefSourceAnswer> {
  const observedAt = new Date(ctx.now).toISOString();
  try {
    const answer = await withinMs<BriefSourceAnswer, typeof SOURCE_TIMED_OUT>(
      Promise.resolve().then(() => reader(ctx)),
      ms,
      () => SOURCE_TIMED_OUT
    );
    if (answer === SOURCE_TIMED_OUT) {
      return { status: 'unavailable', reason: 'timeout', items: [statusRowItem(id, 'unavailable', 'timeout', observedAt)] };
    }
    if ((answer.status === 'unavailable' || answer.status === 'unsupported') && answer.items.length === 0) {
      return { ...answer, items: [statusRowItem(id, answer.status, answer.reason ?? 'read_failed', observedAt)] };
    }
    return answer;
  } catch {
    return { status: 'unavailable', reason: 'read_failed', items: [statusRowItem(id, 'unavailable', 'read_failed', observedAt)] };
  }
}

/** The synchronous re-check before drawing (design §5.4). */
function assertStillSame(
  db: Database.Database,
  target: MemTargetResolved,
  lifetime: MemEvalLifetime,
  input: BuildBriefInput,
  cliToolId: string,
  earlier: InstanceLifetime
): void {
  for (const root of target.members) {
    const mode = decideRootMode(db, root.id, target.detached ? null : target.branch).mode;
    if (mode !== target.mode) throw new BriefMembershipChangedError('mode', mode);
  }
  if (lifetime.via === 'worktree' && getWorktreeIncarnation(db, lifetime.worktreeId) !== lifetime.incarnation) {
    throw new BriefMembershipChangedError('worktree_lifetime');
  }
  if (!isSameInstanceLifetime(earlier, readInstanceLifetime(db, input.worktreeId, input.instanceId), cliToolId)) {
    throw new BriefMembershipChangedError('instance_lifetime');
  }
}

export async function buildBrief(db: Database.Database, input: BuildBriefInput, deps: BriefBuildDeps = {}): Promise<BuildBriefOutcome> {
  const now = deps.now ?? Date.now;
  const time = deps.time ?? input.time;
  const deadline = createBriefDeadline(now, time.totalMs);
  const { worktreeId, instanceId } = input;

  // 1. Before the first await.
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return { kind: 'refused', code: 'not_found' };
  const roster = resolveAgentInstances(db, worktreeId, worktree.selectedAgents);
  const instance = roster.find((entry) => entry.id === instanceId);
  if (!instance) return { kind: 'refused', code: 'instance_not_found' };
  if (getAllRepositories(db).length === 0) return { kind: 'refused', code: 'not_registered' };
  const spec = { via: 'worktree' as const, worktreeId };
  const lifetime = fixMemEvalLifetime(db, spec);
  const earlier = readInstanceLifetime(db, worktreeId, instanceId);
  if (
    input.request &&
    !isSameInstanceLifetime({ incarnation: input.request.target.instanceIncarnation, onRoster: earlier.onRoster }, earlier, instance.cliTool)
  ) {
    throw new BriefMembershipChangedError('instance_lifetime');
  }

  // 2. The membership, within the deadline (2nd review ⑥).
  const resolved = await withinMs<MemTarget, typeof MEMBERSHIP_TIMED_OUT>(
    withMemTarget(db, spec, deps.target ?? {}, (target) => target),
    deadline.remaining() - time.membershipReserveMs,
    () => MEMBERSHIP_TIMED_OUT
  );
  if (resolved === MEMBERSHIP_TIMED_OUT || deadline.expired()) {
    if (input.onMembershipTimeout === 'throw') throw new BriefDeadlineExpiredError('membership');
    return { kind: 'refused', code: 'ambiguous', reason: 'registration_changed' };
  }
  const target = resolved;
  if (!target.ok) return { kind: 'refused', code: target.code, ...(target.reason ? { reason: target.reason } : {}) };
  if (target.mode === 'off') return { kind: 'refused', code: 'disabled', mode: 'off' };
  const mode = target.mode;
  if (input.request && briefMembershipKey(input.request.membership) !== keyOfTarget(target)) {
    throw new BriefMembershipChangedError('membership', mode);
  }
  if (input.maxLines !== undefined && input.maxLines < BRIEF_TEXT_FIXED_LINES) return { kind: 'empty', mode };

  // 3. #4222's evaluation (`on` only), within what is left.
  const conditions = new Map<string, MemConditionView>();
  if (mode === 'on' && deadline.remaining() >= time.evaluateMinMs) {
    const evaluateMs = Math.min(time.evaluateCapMs, deadline.remaining() - time.evaluateReserveMs);
    const report = await withinMs(
      evaluateMemConditions(db, target, {
        trigger: 'brief',
        caller: { worktreeId, instanceId },
        lifetime,
        deadlineMs: Math.max(0, evaluateMs),
        deps: deps.evaluation,
      }),
      Math.max(0, evaluateMs + 50),
      () => null
    );
    if (report) for (const result of report.results) conditions.set(result.itemId, result.condition);
  }
  if (deadline.expired()) throw new BriefDeadlineExpiredError('evaluation');

  // 4. The sources.
  const stamp = now();
  const recipient = mode === 'on' ? captureMemRecipient(db, worktreeId, instanceId, target) : null;
  const readAll = `commandmate brief --worktree ${worktreeId} --instance ${instanceId} --all`;
  const ctx: BriefSourceContext = {
    db,
    worktreeId,
    instanceId,
    cliToolId: instance.cliTool,
    roster,
    target,
    now: stamp,
    readAll,
    conditions,
    recipient,
  };
  const sourceMs = Math.min(time.sourceCapMs, deadline.remaining() - time.sourceReserveMs);
  const observedAt = new Date(stamp).toISOString();
  const answers = await Promise.all(
    BRIEF_SOURCE_IDS.map(async (id): Promise<{ id: BriefSourceId; answer: BriefSourceAnswer | null }> => {
      if (mode === 'derived' && !BRIEF_DERIVED_SOURCES.has(id)) return { id, answer: null };
      return { id, answer: await readOne(id, deps.readers?.[id] ?? BRIEF_SOURCE_READERS[id], ctx, sourceMs) };
    })
  );
  if (deadline.expired()) throw new BriefDeadlineExpiredError('sources');

  // 5. The same as when the build started.
  assertStillSame(db, target, lifetime, input, instance.cliTool, earlier);

  const sources: BriefSourceReport[] = answers.map(({ id, answer }) => ({
    id,
    status: answer ? answer.status : 'skipped',
    ...(answer?.reason ? { reason: answer.reason } : {}),
    observedAt,
  }));
  const items: BriefItem[] = answers.flatMap(({ answer }) => answer?.items ?? []);
  const repositoryId = fixedId(target.storageRepositoryId, BRIEF_FIXED_LIMITS.repositoryIdChars);
  const model: BriefModel = {
    fixed: {
      mode,
      worktreeId,
      instanceId,
      cliToolId: instance.cliTool,
      repositoryId: repositoryId ?? (target.storageRepositoryId === '' ? null : target.storageRepositoryId),
      repositoryIdBytes: Buffer.byteLength(target.storageRepositoryId, 'utf8'),
      branch: target.detached || target.branch === null ? null : sanitizeBranch(target.branch),
      detached: target.detached,
      boundaryKind: input.request?.boundary.kind ?? null,
      generatedAt: observedAt,
      readAll,
    },
    items: rankBriefItems(items),
    sources,
  };
  return { kind: 'built', model, target, recipient, membershipKey: keyOfTarget(target) };
}
