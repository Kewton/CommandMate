/**
 * `commandmate mem check --suggest [--quiet]`: prompt an agent to update mem (Issue
 * #4226, design `docs/design/mem-prompt-4226.md` §3).
 *
 * Calls A, B and D1 by their exports and changes none of them. No model runs, nothing
 * is sent to a session, nothing stays running: the prompt is the answer to a request.
 *
 * INV-A (§3.6): the last await is always the closing `withMemTarget` (W5), and its
 * build is the one synchronous stretch where the membership (HEAD, registration,
 * lifetimes, boundary) is checked, the rules are applied, the answer is assembled and
 * the record of what was shown is read and written. After the build returns, nothing is
 * read, judged or recorded. Every await goes through `step(id, …)` with an id of
 * {@link MEM_SUGGEST_AWAITS} (`tests/unit/guards/mem-suggest-await-table-4226.test.ts`).
 *
 * @module lib/mem-suggest/service
 */

import { lstatSync } from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';
import { getAllRepositories } from '@/lib/db/db-repository';
import { getWorktreeById } from '@/lib/db/worktree-db';
import { countOpenItems, decideRootMode, getMemRecord, listMem, type MemScope } from '@/lib/db/mem-db';
import { getCurrentBoundary, isSameInstanceLifetime, readInstanceLifetime, type InstanceLifetime } from '@/lib/db/session-brief-db';
import { readShown, settleShown, type ShownRow } from '@/lib/db/suggestion-shown-db';
import { sanitizeBranch } from '@/lib/brief/sanitize';
import { execGitCommandCapture } from '@/lib/git/git-exec';
import { createLogger } from '@/lib/logger';
import { fixMemEvalLifetime } from '@/lib/mem/evaluate';
import { getWorktreeIncarnation } from '@/lib/mem/incarnation';
import { presentMemItem, type MemRecord } from '@/lib/mem/present';
import { memError, memList, type MemOutcome, type MemServiceDeps } from '@/lib/mem/service';
import { withMemTarget, type MemTarget, type MemTargetResolved, type MemTargetSpec } from '@/lib/mem/target';
import { resolveAgentInstances } from '@/lib/session/agent-instances-resolver';
import type { MemConditionView, MemErrorCode, MemKind, MemListResponse } from '@/types/mem';
import {
  isMemSuggestHookEvent,
  MEM_SUGGEST_QUIET_CODES,
  type MemSuggestCode,
  type MemSuggestDiscardReason,
  type MemSuggestHookEvent,
  type MemSuggestion,
  type MemSuggestResponse,
  type MemSuggestSkipped,
} from '@/types/mem-suggest';
import { suggestionFingerprint, suggestionScopeHash } from './fingerprint';
import { formatQuietLine, judgeSuggestions, MEM_SUGGEST_MESSAGES, type SuggestHit } from './rules';

const logger = createLogger('mem-suggest');

/**
 * Every await of #4226 on the server (§3.6). `paths`: which request goes through it.
 * W1 is the route's (`readMemBody`); the route's rule is in the guard: `params`, then
 * W1, then `memSuggest`, then only `NextResponse.json`.
 */
export const MEM_SUGGEST_AWAITS = {
  W1: { await: 'readMemBody (the route)', paths: ['quiet', 'full'], position: 'before the fix' },
  W2: { await: 'deps.listBranches (git for-each-ref refs/heads)', paths: ['quiet'], position: 'after the fix, before the membership' },
  W3: { await: 'withMemTarget (the first membership; T0 and R0)', paths: ['full'], position: 'after the fix' },
  W4: { await: 'memList (the evaluation of B)', paths: ['full'], position: 'after W3 and the check before memList' },
  W5: { await: 'withMemTarget (the closing membership; its build is INV-A)', paths: ['quiet', 'full'], position: 'last' },
} as const;
export type MemSuggestAwaitId = keyof typeof MEM_SUGGEST_AWAITS;

/** How an await is run. Tests replace it to change the state right after one resolves. */
export type MemSuggestStep = <T>(id: MemSuggestAwaitId, run: () => Promise<T>) => Promise<T>;

/** The one helper that hands a promise on without awaiting it (the guard names it). */
const runStep: MemSuggestStep = (_id, run) => run();

/** What `git for-each-ref` answered (the shape of `execGitCommandCapture`). */
export interface BranchListing {
  ok: boolean;
  stdout: string;
}

export interface MemSuggestDeps extends MemServiceDeps {
  /** The worktree's local branches (W2). Default: `git for-each-ref refs/heads`. */
  listBranches?: (worktreePath: string) => Promise<BranchListing>;
  step?: MemSuggestStep;
}

const BRANCH_ARGS = ['for-each-ref', '--format=%(refname:short) %(refname)', 'refs/heads'];

/** The server's bound of a quiet request (§3.6, 5): shorter than the CLI's 4 seconds. */
export const MEM_SUGGEST_QUIET_DEADLINE_MS = 3000;

// ---------------------------------------------------------------------------
// The fix (the first synchronous stretch after W1)
// ---------------------------------------------------------------------------

interface Fixed {
  worktreeId: string;
  worktreePath: string;
  spec: MemTargetSpec;
  full: boolean;
  hook: MemSuggestHookEvent | null;
  /** null: no identity, or an id that is neither on the roster nor has an incarnation. */
  instanceId: string | null;
  onRoster: boolean;
  /** The tool the lifetime is compared with (`C0`). */
  tool: string | null;
  lifetime: InstanceLifetime | null;
  worktreeIncarnation: string;
  boundary: string | null;
  startedAt: number;
  now: () => number;
}

type Fixing = { ok: true; fixed: Fixed } | { ok: false; outcome: MemOutcome };

function fixRequest(db: Database.Database, worktreeId: string, body: Record<string, unknown>, deps: MemSuggestDeps): Fixing {
  const worktree = getWorktreeById(db, worktreeId);
  if (!worktree) return { ok: false, outcome: memError('not_found') };
  if (body.instanceId !== undefined && body.instanceId !== null && (typeof body.instanceId !== 'string' || body.instanceId.length === 0)) {
    return { ok: false, outcome: memError('invalid_request', { field: 'instanceId' }) };
  }
  if (typeof body.full !== 'boolean') return { ok: false, outcome: memError('invalid_request', { field: 'full' }) };
  if (body.hook !== undefined && body.hook !== null && !isMemSuggestHookEvent(body.hook)) {
    return { ok: false, outcome: memError('invalid_request', { field: 'hook' }) };
  }
  const spec: MemTargetSpec = { via: 'worktree', worktreeId };
  const now = deps.now ?? Date.now;
  const asked = typeof body.instanceId === 'string' ? body.instanceId : null;
  const member = asked === null ? undefined : resolveAgentInstances(db, worktreeId, worktree.selectedAgents).find((entry) => entry.id === asked);
  const lifetime = asked === null ? null : readInstanceLifetime(db, worktreeId, asked);
  // §3.6 "the direct route": the resolved roster (a derived primary included) or an incarnation.
  const known = asked !== null && (member !== undefined || lifetime?.incarnation != null);
  const instanceId = known ? asked : null;
  return {
    ok: true,
    fixed: {
      worktreeId,
      worktreePath: worktree.path,
      spec,
      full: body.full,
      hook: isMemSuggestHookEvent(body.hook) ? body.hook : null,
      instanceId,
      onRoster: member !== undefined,
      tool: member?.cliTool ?? lifetime?.incarnationToolId ?? null,
      lifetime: known ? lifetime : null,
      worktreeIncarnation: (fixMemEvalLifetime(db, spec) as { incarnation: string }).incarnation,
      boundary: instanceId === null ? null : (getCurrentBoundary(db, worktreeId, instanceId)?.id ?? null),
      startedAt: now(),
      now,
    },
  };
}

// ---------------------------------------------------------------------------
// The answers
// ---------------------------------------------------------------------------

function response(fixed: Fixed, extra: Partial<MemSuggestResponse>): MemOutcome {
  const body: MemSuggestResponse = {
    ok: true,
    mode: null,
    branch: null,
    instanceId: fixed.instanceId,
    full: fixed.full,
    hook: fixed.hook,
    suggestions: [],
    skipped: [],
    discarded: null,
    ...(fixed.full ? {} : { quietLine: null }),
    ...extra,
  };
  return { status: 200, body };
}

function discard(fixed: Fixed, target: MemTargetResolved, reason: MemSuggestDiscardReason): MemOutcome {
  logger.info('mem-suggest-discarded', { worktreeId: fixed.worktreeId, instanceId: fixed.instanceId, full: fixed.full, reason });
  return response(fixed, { mode: target.mode, branch: branchOf(target), discarded: reason });
}

function failure(target: Exclude<MemTarget, MemTargetResolved>): MemOutcome {
  return memError(target.code, { ...(target.reason ? { reason: target.reason } : {}), ...(target.roots ? { roots: target.roots } : {}) });
}

function branchOf(target: MemTargetResolved): string | null {
  if (target.detached || target.branch === null) return null;
  const sanitized = sanitizeBranch(target.branch);
  return sanitized.kind === 'ok' ? sanitized.value : null;
}

const headBranch = (target: MemTargetResolved): string | null => (target.detached ? null : target.branch);

/** The registration the membership was judged by: the resolver's `rootsSignature`, kept here (A unchanged). */
function registrationOf(db: Database.Database): string {
  return JSON.stringify(getAllRepositories(db).map((root) => [root.id, root.path, root.enabled]));
}

function scopeOf(target: MemTargetResolved, worktreeId: string): MemScope {
  return {
    storageRepositoryId: target.storageRepositoryId,
    readRepositoryIds: target.readRepositoryIds,
    branch: headBranch(target),
    worktreeId: target.worktree?.id ?? worktreeId,
  };
}

/** What the build of the membership decides before anything else: off, derived, prompts off. */
function gateOf(fixed: Fixed, target: MemTargetResolved): MemOutcome | null {
  if (target.mode !== 'on') return memError('disabled', { mode: target.mode, source: target.source });
  if (!target.features.promptOnEvents) return response(fixed, { mode: target.mode, branch: branchOf(target), disabledBy: 'promptOnEvents' });
  return null;
}

// ---------------------------------------------------------------------------
// The checks (§3.6 1〜3, 5), synchronous
// ---------------------------------------------------------------------------

function lifetimeMoved(db: Database.Database, fixed: Fixed): MemSuggestDiscardReason | null {
  const worktree = getWorktreeById(db, fixed.worktreeId);
  if (!worktree || getWorktreeIncarnation(db, fixed.worktreeId) !== fixed.worktreeIncarnation) return 'worktree_lifetime';
  if (fixed.instanceId === null || fixed.lifetime === null) return null;
  const instanceId = fixed.instanceId;
  const onRosterNow = resolveAgentInstances(db, fixed.worktreeId, worktree.selectedAgents).some((entry) => entry.id === instanceId);
  if (fixed.onRoster && !onRosterNow) return 'instance_lifetime';
  if (!isSameInstanceLifetime(fixed.lifetime, readInstanceLifetime(db, fixed.worktreeId, instanceId), fixed.tool ?? '')) return 'instance_lifetime';
  return null;
}

function settingsMoved(db: Database.Database, target: MemTargetResolved, registration: string): MemSuggestDiscardReason | null {
  if (registrationOf(db) !== registration) return 'registration';
  for (const root of target.members) {
    const decision = decideRootMode(db, root.id, headBranch(target));
    if (decision.mode !== 'on') return 'mode';
    if (!decision.features.promptOnEvents) return 'prompt_off';
  }
  return null;
}

// ---------------------------------------------------------------------------
// The copies before and after the evaluation (§3.2), full only
// ---------------------------------------------------------------------------

interface Copy {
  kind: MemKind;
  version: number;
  closeWhen: string | null;
  state: string;
}

function copyOf(db: Database.Database, scope: MemScope, fixed: Fixed): Map<string, Copy> {
  const listed = listMem(db, scope);
  const out = new Map<string, Copy>();
  for (const record of listed.items) out.set(record.id, { kind: record.kind, version: record.version, closeWhen: record.closeWhen, state: record.state });
  for (const slot of listed.now) {
    if (slot.worktreeId === fixed.worktreeId && slot.instanceId === fixed.instanceId) {
      out.set(slot.record.id, { kind: 'now', version: slot.record.version, closeWhen: slot.record.closeWhen, state: slot.record.state });
    }
  }
  return out;
}

interface Conditions {
  usable: Map<string, MemConditionView>;
  closedNow: MemRecord | null;
  changed: MemSuggestSkipped[];
}

/** Bind the results of `memList` to the items as they were before and are now (§3.2). */
function bindConditions(db: Database.Database, before: Map<string, Copy>, results: Record<string, MemConditionView>): Conditions {
  const usable = new Map<string, MemConditionView>();
  const changed: MemSuggestSkipped[] = [];
  let closedNow: MemRecord | null = null;
  for (const [itemId, condition] of Object.entries(results)) {
    const was = before.get(itemId);
    const code: MemSuggestCode = was?.kind === 'now' ? 'now_condition_met' : was?.kind === 'decision' ? 'decision_unreflected' : 'ref_unknown';
    const record = getMemRecord(db, itemId);
    if (!was || !record) {
      changed.push({ code, reason: record ? 'version_changed' : 'record_gone', itemId });
      continue;
    }
    const sameCondition = record.closeWhen === was.closeWhen;
    if (condition.closed) {
      const byCondition = record.state === 'closed' && record.closeReason === 'condition' && sameCondition;
      // A `now` keeps its slot's version when it is archived; an item's goes up by one.
      const fits = byCondition && (was.kind === 'now' ? record.kind === 'now' && record.version === was.version : record.version === was.version + 1);
      if (!fits) changed.push({ code, reason: 'version_changed', itemId });
      else if (was.kind === 'now') closedNow = record;
      else usable.set(itemId, condition);
      continue;
    }
    if (record.version === was.version && sameCondition && record.state === was.state) usable.set(itemId, condition);
    else changed.push({ code, reason: 'version_changed', itemId });
  }
  return { usable, closedNow, changed };
}

// ---------------------------------------------------------------------------
// The build of the last await (INV-A)
// ---------------------------------------------------------------------------

/** Each `path:` entry is walked from the worktree's root with `lstat`; a symbolic link is "missing" (A §6.2). */
function missingEvidenceOf(root: string, record: MemRecord): number {
  let missing = 0;
  for (const entry of record.evidence) {
    if (!entry.startsWith('path:')) continue;
    const relative = entry.slice('path:'.length).replace(/:[1-9][0-9]{0,6}$/, '');
    let current = root;
    for (const segment of relative.split('/').filter((part) => part.length > 0)) {
      current = path.join(current, segment);
      try {
        if (lstatSync(current).isSymbolicLink()) {
          missing += 1;
          break;
        }
      } catch {
        missing += 1;
        break;
      }
    }
  }
  return missing;
}

/** Whether a stored incarnation is the instance's lifetime now: `isSameInstanceLifetime`'s rule (null → lazy is the same). */
function sameIncarnation(stored: string | null, now: InstanceLifetime, tool: string | null): boolean {
  if (stored === now.incarnation) return true;
  return stored === null && now.incarnation !== null && now.incarnationIssuedBy === 'lazy' && now.incarnationToolId === tool;
}

/** The branch names git lists, in both the short and the full form (§3.6 W2, the refname check). */
function branchesOf(listing: BranchListing): string[] | null {
  if (!listing.ok) return null;
  const names: string[] = [];
  for (const line of listing.stdout.split('\n')) {
    const [short, full] = line.trim().split(' ');
    if (short) names.push(short);
    if (full?.startsWith('refs/heads/')) names.push(full.slice('refs/heads/'.length));
  }
  return names;
}

interface Closing {
  db: Database.Database;
  fixed: Fixed;
  /** quiet: the branches of W2 (null: git did not answer). */
  branches?: string[] | null;
  /** full: what W3 and W4 left. */
  opening?: { target: MemTargetResolved; registration: string; before: Map<string, Copy>; listed: MemOutcome };
}

/** INV-A: the checks, the rules, the answer and the record, in the one synchronous stretch of W5's build. */
function closeRequest(closing: Closing, outcome: MemTarget): MemOutcome {
  const { db, fixed, opening } = closing;
  if (!outcome.ok) {
    if (!opening) return failure(outcome);
    return discard(fixed, opening.target, outcome.code === 'not_found' ? 'worktree_lifetime' : 'membership');
  }
  let target: MemTargetResolved = outcome;
  let registration = registrationOf(db);
  if (opening) {
    const first = opening.target;
    if (outcome.storageRepositoryId !== first.storageRepositoryId || outcome.members.map((r) => r.id).join('\n') !== first.members.map((r) => r.id).join('\n')) {
      return discard(fixed, first, 'membership');
    }
    if (headBranch(outcome) !== headBranch(first)) return discard(fixed, first, 'branch');
    target = first;
    registration = opening.registration;
  } else {
    const gate = gateOf(fixed, target);
    if (gate) return gate;
  }
  const moved = lifetimeMoved(db, fixed) ?? settingsMoved(db, target, registration);
  if (moved) return discard(fixed, target, moved);
  let conditions: Conditions = { usable: new Map(), closedNow: null, changed: [] };
  if (opening) {
    if (opening.listed.status !== 200) {
      return discard(fixed, target, (opening.listed.body as { code?: MemErrorCode }).code === 'disabled' ? 'mode' : 'membership');
    }
    const listed = opening.listed.body as MemListResponse;
    if (listed.mode !== target.mode) return discard(fixed, target, 'mode');
    if (listed.branch !== headBranch(target)) return discard(fixed, target, 'branch');
    conditions = bindConditions(db, opening.before, listed.conditions ?? {});
  } else {
    const instanceId = fixed.instanceId as string;
    if ((getCurrentBoundary(db, fixed.worktreeId, instanceId)?.id ?? null) !== fixed.boundary) return discard(fixed, target, 'boundary');
    if (fixed.now() - fixed.startedAt > MEM_SUGGEST_QUIET_DEADLINE_MS) return discard(fixed, target, 'deadline');
    if (!closing.branches) {
      return response(fixed, { mode: target.mode, branch: branchOf(target), skipped: [{ code: 'all', reason: 'branches_unknown' }] });
    }
  }

  // The materials, read now (the copy after, §3.2).
  const scope = scopeOf(target, fixed.worktreeId);
  const listedNow = listMem(db, scope);
  const lifetimeNow = fixed.instanceId === null ? null : readInstanceLifetime(db, fixed.worktreeId, fixed.instanceId);
  const slot = listedNow.now.find((entry) => entry.worktreeId === fixed.worktreeId && entry.instanceId === fixed.instanceId)?.record ?? null;
  const openCounts: Partial<Record<Exclude<MemKind, 'now'>, number>> = {};
  for (const kind of ['waiting', 'next', 'external', 'note', 'decision'] as const) openCounts[kind] = countOpenItems(db, scope, kind);
  const at = fixed.now();
  const judgement = judgeSuggestions({
    full: fixed.full,
    now: at,
    caller:
      fixed.instanceId === null || lifetimeNow === null
        ? null
        : { instanceId: fixed.instanceId, incarnation: lifetimeNow.incarnation, onRoster: fixed.onRoster },
    slot,
    items: listedNow.items,
    openCounts,
    conditions: conditions.usable,
    closedNow: conditions.closedNow,
    versionChanged: conditions.changed,
    missingEvidence: (record) => missingEvidenceOf(fixed.worktreePath, record),
    withheld: (record) => presentMemItem(record, { now: at }).withheld !== undefined,
  });

  // What was shown already, in this scope only.
  const scopeHash = suggestionScopeHash(target.storageRepositoryId, headBranch(target));
  const shown = fixed.instanceId === null ? new Map<string, ShownRow>() : readShown(db, fixed.worktreeId, fixed.instanceId, scopeHash);
  const valueOf = (hit: SuggestHit) => suggestionFingerprint(hit.code, hit.material);
  const isShown = (hit: SuggestHit): boolean => {
    const row = shown.get(hit.code);
    return (
      row !== undefined &&
      lifetimeNow !== null &&
      row.fingerprint === valueOf(hit) &&
      row.boundaryId === fixed.boundary &&
      sameIncarnation(row.instanceIncarnation, lifetimeNow, fixed.tool)
    );
  };
  const suggestions: MemSuggestion[] = judgement.hits.map((hit) => ({
    code: hit.code,
    itemIds: hit.itemIds,
    versions: hit.versions,
    fingerprint: valueOf(hit),
    shown: isShown(hit),
    ...MEM_SUGGEST_MESSAGES[hit.code],
  }));

  if (fixed.full) {
    logger.info('mem-suggested', { worktreeId: fixed.worktreeId, instanceId: fixed.instanceId, full: true, codes: suggestions.map((s) => s.code) });
    return response(fixed, { mode: target.mode, branch: branchOf(target), suggestions, skipped: judgement.skipped });
  }

  // quiet: the new prompts only, recorded (§4).
  const instanceId = fixed.instanceId as string;
  const fresh = judgement.hits.filter((hit) => !isShown(hit));
  const incarnation = (lifetimeNow as InstanceLifetime).incarnation;
  const rewrite = judgement.hits.filter((hit) => isShown(hit) && shown.get(hit.code)?.instanceIncarnation !== incarnation);
  const hitCodes = new Set(judgement.hits.map((hit) => hit.code));
  const roots = getAllRepositories(db).map((root) => root.id);
  const live = new Set<string>([scopeHash]);
  for (const root of roots) {
    live.add(suggestionScopeHash(root, null));
    for (const branch of closing.branches as string[]) live.add(suggestionScopeHash(root, branch));
  }
  const worktree = getWorktreeById(db, fixed.worktreeId);
  settleShown(db, {
    worktreeId: fixed.worktreeId,
    instanceId,
    scopeHash,
    write: [
      ...fresh.map((hit) => ({ code: hit.code, instanceIncarnation: incarnation, boundaryId: fixed.boundary, fingerprint: valueOf(hit), shownAt: at })),
      ...rewrite.map((hit) => ({ ...(shown.get(hit.code) as ShownRow), instanceIncarnation: incarnation })),
    ],
    clear: judgement.evaluated.filter((code) => !hitCodes.has(code)),
    rosterInstanceIds: worktree ? resolveAgentInstances(db, fixed.worktreeId, worktree.selectedAgents).map((entry) => entry.id) : [],
    knownCodes: MEM_SUGGEST_QUIET_CODES,
    liveScopeHashes: live,
  });
  logger.info('mem-suggested', { worktreeId: fixed.worktreeId, instanceId, full: false, hook: fixed.hook, fresh: fresh.map((hit) => hit.code) });
  return response(fixed, {
    mode: target.mode,
    branch: branchOf(target),
    suggestions: suggestions.filter((suggestion) => !suggestion.shown),
    skipped: judgement.skipped,
    quietLine: formatQuietLine(fresh),
  });
}

/** W3's build: T0 and R0, or the answer when T0 is already off / derived / prompts off (P2-4). */
function openRequest(db: Database.Database, fixed: Fixed, outcome: MemTarget): { answer: MemOutcome } | { target: MemTargetResolved; registration: string } {
  if (!outcome.ok) return { answer: failure(outcome) };
  const gate = gateOf(fixed, outcome);
  if (gate) return { answer: gate };
  return { target: outcome, registration: registrationOf(db) };
}

// ---------------------------------------------------------------------------
// The entrance
// ---------------------------------------------------------------------------

/**
 * `POST /api/worktrees/:id/mem/suggest` — `{ instanceId?, full, hook? }`. `full` runs
 * B's evaluation (`memList`, which may close what is met); quiet asks no condition and
 * records what it showed. Order: quiet W1 → fix → W2 → W5; full W1 → fix → W3 → the
 * check before `memList` → W4 → W5.
 */
export async function memSuggest(
  db: Database.Database,
  worktreeId: string,
  body: Record<string, unknown>,
  deps: MemSuggestDeps = {}
): Promise<MemOutcome> {
  const step = deps.step ?? runStep;
  const fixing = fixRequest(db, worktreeId, body, deps);
  if (!fixing.ok) return fixing.outcome;
  const fixed = fixing.fixed;

  if (!fixed.full) {
    // An identity is the key of the record: without one, quiet does nothing (§3.6).
    if (fixed.instanceId === null) return response(fixed, {});
    const listing = await step('W2', () =>
      deps.listBranches ? deps.listBranches(fixed.worktreePath) : execGitCommandCapture(BRANCH_ARGS, fixed.worktreePath)
    );
    const branches = branchesOf(listing);
    const answer = await step('W5', () => withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, branches }, outcome)));
    return answer;
  }

  const opened = await step('W3', () => withMemTarget(db, fixed.spec, deps, (outcome) => openRequest(db, fixed, outcome)));
  if ('answer' in opened) return opened.answer;
  // The check before memList (§3.6): memList fixes the worktree's lifetime again and
  // closes what is met, so nothing it would close may belong to another lifetime.
  const moved = lifetimeMoved(db, fixed) ?? settingsMoved(db, opened.target, opened.registration);
  if (moved) return discard(fixed, opened.target, moved);
  const before = copyOf(db, scopeOf(opened.target, worktreeId), fixed);
  const listed = await step('W4', () => memList(db, fixed.spec, fixed.instanceId === null ? {} : { instanceId: fixed.instanceId }, deps));
  const answer = await step('W5', () =>
    withMemTarget(db, fixed.spec, deps, (outcome) => closeRequest({ db, fixed, opening: { ...opened, before, listed } }, outcome))
  );
  return answer;
}
