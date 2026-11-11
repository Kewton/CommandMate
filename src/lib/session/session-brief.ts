/**
 * Putting a session brief in front of the first send after a boundary, once
 * (Issue #4274, design `docs/design/session-boundary-brief-4274.md` §3.4〜§3.7・§5・§6).
 *
 * One {@link SendBrief} per `sendUserMessage` call, in four steps:
 *
 *  1. {@link SendBrief.plan} — outside the input lock: the instance's current boundary,
 *     its lifetime, the membership and mode (`withMemTarget`), the budget, and the
 *     provider's text. Off, disabled, unresolved, empty, failed or over budget: the
 *     boundary is used up unbriefed (`skipped`), and the body is sent as it is.
 *  2. {@link SendBrief.claim} — under the lock, right before the body is typed:
 *     `withMemTarget` again, and in its synchronous stretch the membership, the mode,
 *     the lifetime, the provider's reservation and the claim itself (2nd review B, D).
 *     A second send, or a newer boundary, finds nothing to claim.
 *  3. {@link SendBrief.settleInLock} — still under the lock: the outcome of the send
 *     on the claimed row, and a reset this send typed opens its row (2nd review A).
 *  4. {@link SendBrief.afterLock} — the provider is told how it ended.
 *
 * The operator's body is never cut: a brief that does not fit is left off.
 *
 * Issue #4224 (D2, design `docs/design/brief-injection-d2-4224.md` §2): a send's request
 * is for one worktree lifetime and one instance lifetime, fixed at its entrance
 * ({@link pinBriefWorktree} where the route reads the worktree, {@link pinBriefRequest}
 * where it resolves the instance) and carried here as `pin`. The plan, the claim and the
 * reset's row never read them again: each asks whether the worktree pinned is still the
 * one found ({@link SendBrief}'s continuity), and a worktree deleted and made again
 * under the same id meanwhile gets nothing of this request (`worktree_changed`).
 *
 * @module lib/session/session-brief
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import {
  claimBoundary,
  copyDeliveryToRelaunchBoundaries,
  fillBoundaryIncarnation,
  getBoundaryById,
  getCurrentBoundary,
  getLatestWorktreeBoundaryId,
  isSameInstanceLifetime,
  openBoundary,
  readInstanceLifetime,
  settleBoundaryClaim,
  settleDeclinedClaim,
  settleStaleClaim,
  skipBoundary,
  type BoundaryOutcome,
  type BoundaryRow,
  type BoundarySkipReason,
  type BoundaryState,
  type InstanceLifetime,
} from '@/lib/db/session-brief-db';
import { withMemTarget, type MemTarget, type MemTargetDeps } from '@/lib/mem/target';
import { getOrCreateWorktreeIncarnation, getWorktreeIncarnation } from '@/lib/mem/incarnation';
import { getAllRepositories } from '@/lib/db/db-repository';
import { getMemSettings } from '@/lib/db/mem-db';
import type { MemMode, MemRepositorySettings } from '@/types/mem';
import {
  getBriefProvider,
  type BriefBoundaryKind,
  type BriefDeliveryOutcome,
  type BriefProvider,
  type BriefResult,
} from '@/lib/session/brief-provider';
import {
  BOUNDARY_TOOLS,
  boundaryDatabaseFor,
  isResetCommandBody,
  isSlashCommandBody,
  openResetBoundaryFromSend,
} from '@/lib/session/session-boundary';
import { SEND_VERIFIED_MAX_BYTES, SEND_VERIFIED_MAX_LINES } from '@/config/send-verified-limits';
import { BRIEF_BUDGET } from '@/types/brief';
import type { SendAttemptState } from '@/lib/session/send-attempt-types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session/session-brief');

/**
 * What a send asks of the brief (design §4.1). The service's default is `never`.
 * Issue #4227 (S-B): `decline` — the screen's "don't read": the boundary the preview showed is
 * used up as `skipped(declined)` once the body went in, and nothing is attached.
 */
export type BriefSendMode = 'auto' | 'skip' | 'force' | 'never' | 'decline';

/** Issue #4227 (S-B): how much of the brief `auto` asks for. `full` lifts C's per-entry cap (S-F). */
export type BriefDetail = 'short' | 'full';

/**
 * Issue #4227 (S-B, design §3.2): a `full` / `decline` send stopped before any key, because
 * the boundary the screen showed is no longer the one it would act on (or the brief chosen
 * could not be made). Thrown by {@link SendBrief.claim}; the send service reads it by its
 * type only (`instanceof`), never by its message (5th review P2(1)).
 */
export class BriefChoiceAbortedError extends Error {
  constructor(
    readonly reason: string,
    readonly boundary: { id: string; state: BoundaryState } | null
  ) {
    super(`brief choice aborted (${reason}); nothing was typed`);
    this.name = 'BriefChoiceAbortedError';
  }
}

/**
 * Issue #4227 (S-B, design §3.2 — the final reading's invariant, pr3d): what the plan left a
 * strict choice (`full` / `decline`) with. None of these decides the shown row: whichever it is,
 * {@link SendBrief.claim} holds the instance's current row to one predicate first (pr3e: the same
 * conditions for every outcome — identity, state, worktree / instance, settings), under the input
 * lock right before the body, and only then commits (pr3f, {@link STRICT_COMMIT_RULES}). A new outcome
 * is added here and in {@link strictKindOf}'s exhaustive switch (the table test
 * `session-brief-final-reading-4227` builds its rows from this list).
 *
 *  - `planned` — the brief (`full`) or the reservation (`decline`) is ready to be claimed;
 *  - `used_up` — the shown row was used up by another send (the body alone, `consumed`);
 *  - `empty` — `full`'s brief came out empty (the body alone, the row claimed and settled `empty`);
 *  - `refused` — the plan stopped the send (its reason is the abort's; nothing is typed).
 *
 * pr3f (PM decision 5): a command (`/…`) with a strict choice is the route's 400 (the screen never
 * offers the choice for one, design §3.2.1); the service stops it at the plan (`slash_command`).
 */
export const STRICT_PLAN_OUTCOMES = ['planned', 'used_up', 'empty', 'refused'] as const;
export type StrictPlanOutcome = (typeof STRICT_PLAN_OUTCOMES)[number];

/**
 * Issue #4227 (pr3f, the invariant S-B-commit): what a strict choice's commit acts on once the final
 * reading held — `brief` (`full` with a brief), `decline`, `empty` (`full`, nothing to attach),
 * `used_up` (another send used the shown row up).
 */
export type StrictKind = 'brief' | 'decline' | 'empty' | 'used_up';

/** pr3f: the commit's one answer — the text to type, and nothing else, or why nothing is typed. */
export type StrictCommit = { type: 'type'; text: string } | StrictAbort;
export type StrictAbort = { type: 'abort'; reason: string };

/** pr3f: what a kind's commit does (one table; the commit reads it, the table test builds its rows from it). */
export interface StrictCommitRule {
  /**
   * The writes made before the body, in order. None uses the shown row up: the most is `claimed`
   * (with this send's token). Any of them failing — a throw, no row changed, withheld, a reservation
   * that answers nothing — is an abort: nothing typed, the row as it was.
   */
  writes: readonly Extract<BriefWriteSite, 'claim.reserve' | 'claim.row'>[];
  /** What is typed: the brief in front of the body, or the body alone. */
  typed: 'brief_and_body' | 'body';
  /**
   * How the claim is settled once the delivery answered (`settleInLock`): `delivery` — the outcome as
   * it is (`sent` / `unknown` / `not_sent`); `declined` / `empty` — `sent` or `unknown` use the row up
   * as `skipped(<this>)`. `not_sent` always puts it back to `pending`. null: nothing claimed, nothing
   * settled (the report is the commit's: `consumed`).
   */
  settle: 'delivery' | 'declined' | 'empty' | null;
}

export const STRICT_COMMIT_RULES = {
  brief: { writes: ['claim.reserve', 'claim.row'], typed: 'brief_and_body', settle: 'delivery' },
  decline: { writes: ['claim.row'], typed: 'body', settle: 'declined' },
  empty: { writes: ['claim.row'], typed: 'body', settle: 'empty' },
  used_up: { writes: [], typed: 'body', settle: null },
} as const satisfies Record<StrictKind, StrictCommitRule>;

const abort = (reason: string): StrictAbort => ({ type: 'abort', reason });

/** pr3f: an answer is a commit only when it is exactly one of the two shapes (null, undefined: not). */
function isStrictCommit(answer: unknown): answer is StrictCommit {
  if (typeof answer !== 'object' || answer === null) return false;
  const value = answer as { type?: unknown; text?: unknown; reason?: unknown };
  return (value.type === 'type' && typeof value.text === 'string') || (value.type === 'abort' && typeof value.reason === 'string');
}

/** pr3f: the kind a plan outcome commits as (`refused` never commits). */
function strictKindOf(outcome: Exclude<StrictPlanOutcome, 'refused'>, declined: boolean): StrictKind {
  switch (outcome) {
    case 'planned':
      return declined ? 'decline' : 'brief';
    case 'empty':
      return 'empty';
    case 'used_up':
      return 'used_up';
    default: {
      const unknownOutcome: never = outcome;
      throw new Error(`unknown plan outcome: ${String(unknownOutcome)}`);
    }
  }
}

/** pr3f: thrown inside the claim's transaction to roll a write that changed no row back. */
class ClaimRolledBack extends Error {
  constructor() {
    super('claim rolled back');
    this.name = 'ClaimRolledBack';
  }
}

/** Between the brief and the operator's body (D12: the brief's own framing is C's). */
export const BRIEF_SEPARATOR = '\n\n';

/** How long a provider may take before the body is sent without it (design §5.1, U7). */
export const BRIEF_PROVIDER_TIMEOUT_MS = 2_000;

/** What a send says about its brief (the route's `brief` field). */
export interface BriefReport {
  /** Issue #4227: `consumed` — a `full` / `decline` send found its boundary used up by another send (body only). */
  state: 'attached' | 'skipped' | 'unknown' | 'not_sent' | 'consumed';
  reason?: string;
  boundaryId?: string;
}

// ---------------------------------------------------------------------------
// The request's lifetimes, fixed at its entrance (Issue #4224, D2 design §2.4)
// ---------------------------------------------------------------------------

/** What a send request's worktree was, read where the request first read the worktree (W1). */
export interface BriefWorktreePin {
  worktreeId: string;
  /** `mem_worktree_incarnations` at the entrance; null when it had none and none was made. */
  worktreeIncarnation: string | null;
  /** The worktree's newest ledger row at the entrance (any instance, any state); null with none. */
  anchorBoundaryId: string | null;
}

/** What a send request was read for: its worktree and its instance, fixed once (W1). */
export interface BriefRequestPin extends BriefWorktreePin {
  instanceId: string;
  instance: InstanceLifetime;
}

const NO_LIFETIME: InstanceLifetime = { incarnation: null, incarnationToolId: null, incarnationIssuedBy: null, onRoster: false };

/** Whether a repository's stored settings could put a brief in front of a send (any branch). */
function settingsMayAttach(settings: MemRepositorySettings): boolean {
  const ruleOn = settings.rules.some((rule) => rule.mode !== 'off');
  const base = settings.features.injectOnStart && (ruleOn || settings.overrides.some((o) => o.mode !== null && o.mode !== 'off' && o.injectOnStart !== false));
  const override = settings.overrides.some((o) => o.injectOnStart === true && ((o.mode !== null && o.mode !== 'off') || (o.mode === null && ruleOn)));
  return base || override;
}

/**
 * The entrance's synchronous guess (2nd review ①): whether the stored settings of the
 * worktree's repository (by its stored `repository_path`; every repository when none
 * matches) could attach a brief. Only then does the entrance make the worktree's
 * incarnation, so a first send to a worktree with none (the launch it starts opens the
 * first row) is pinned too — and `off` / disabled settings write nothing (W5).
 */
export function briefMayAttach(db: Database.Database, worktreeId: string): boolean {
  const worktree = db.prepare('SELECT repository_path FROM worktrees WHERE id = ?').get(worktreeId) as
    | { repository_path: string | null }
    | undefined;
  if (!worktree) return false;
  const repositories = getAllRepositories(db);
  const matching = repositories.filter((repository) => repository.path === worktree.repository_path);
  return (matching.length > 0 ? matching : repositories).some((repository) => settingsMayAttach(getMemSettings(db, repository.id)));
}

/**
 * Step 1 of the entrance (D2 design §2.4): in the synchronous stretch the route reads the
 * worktree in, before the body (which names the instance) is parsed. Reads the worktree's
 * incarnation and newest ledger row; makes the incarnation only when {@link briefMayAttach}.
 * Fails open: a database it cannot read pins nothing (no brief, the body is sent).
 */
export function pinBriefWorktree(dbLike: unknown, worktreeId: string): BriefWorktreePin {
  const empty: BriefWorktreePin = { worktreeId, worktreeIncarnation: null, anchorBoundaryId: null };
  const db = boundaryDatabaseFor(dbLike);
  if (!db) return empty;
  try {
    let worktreeIncarnation = getWorktreeIncarnation(db, worktreeId);
    if (worktreeIncarnation === null && briefMayAttach(db, worktreeId)) {
      worktreeIncarnation = writeAtEntrance('entrance.incarnation', () => getOrCreateWorktreeIncarnation(db, worktreeId));
    }
    return { worktreeId, worktreeIncarnation, anchorBoundaryId: getLatestWorktreeBoundaryId(db, worktreeId) };
  } catch (error) {
    logger.warn('session-brief-pin-failed', { worktreeId, error: error instanceof Error ? error.message : String(error) });
    return empty;
  }
}

/** Step 2 of the entrance: where the instance is resolved. The request's pin. Read only. */
export function pinBriefRequest(dbLike: unknown, worktree: BriefWorktreePin, instanceId: string): BriefRequestPin {
  const db = boundaryDatabaseFor(dbLike);
  let instance = NO_LIFETIME;
  if (db) {
    try {
      instance = readInstanceLifetime(db, worktree.worktreeId, instanceId);
    } catch (error) {
      logger.warn('session-brief-pin-failed', { worktreeId: worktree.worktreeId, instanceId, error: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ...worktree, instanceId, instance };
}

/**
 * Whether the worktree a pin was read for is still the one found (W3・W6), from what the
 * delete and the rename take or move (the incarnation row, the ledger rows): `same`,
 * `changed`, or `unknown` when the pin holds no evidence (neither was there).
 */
export function briefWorktreeContinuity(db: Database.Database, pin: BriefWorktreePin): 'same' | 'changed' | 'unknown' {
  if (pin.worktreeIncarnation !== null) {
    return getWorktreeIncarnation(db, pin.worktreeId) === pin.worktreeIncarnation ? 'same' : 'changed';
  }
  if (pin.anchorBoundaryId !== null) {
    return getBoundaryById(db, pin.anchorBoundaryId)?.worktreeId === pin.worktreeId ? 'same' : 'changed';
  }
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Every write is a row of one table (Issue #4224, D2 design §20: the rule, not one edge at a time)
// ---------------------------------------------------------------------------

/**
 * What a write must prove before it is made (D2 design §20.1):
 *  - `entrance` — the entrance's own write, before there is a pin (it makes the evidence a pin holds);
 *  - `same` — the pinned worktree is still the one found (`same`; `unknown` or `changed`: nothing is
 *    written). The row it writes is the planned one, whose instance was read as pinned when it was planned;
 *  - `same-and-instance` — `same`, and the instance is still the lifetime the entrance pinned;
 *  - `reset` — a pinned request needs `same`; an unpinned send (Timer, relay: never briefed) keeps D1's
 *    instance check inside {@link openResetBoundaryFromSend};
 *  - `settled` — tells the provider the outcome `settle.claim` decided (withheld: `unknown`).
 */
export type BriefWriteGuard = 'entrance' | 'same' | 'same-and-instance' | 'reset' | 'settled';

/**
 * Every write this module makes, by site (D2 design §20.2). A writer called outside
 * {@link SendBrief}'s `write` (or {@link writeAtEntrance}) fails the scan
 * (`tests/unit/lib/session/session-brief-write-rule-4224.test.ts`).
 */
export const BRIEF_WRITE_RULES = {
  'entrance.incarnation': 'entrance',
  'plan.stale-claim': 'same-and-instance',
  'plan.dead-row': 'same-and-instance',
  'plan.consume': 'same',
  'plan.incarnation': 'same',
  'claim.consume': 'same',
  'claim.reserve': 'same-and-instance',
  'claim.row': 'same-and-instance',
  'settle.claim': 'same',
  'settle.reset': 'reset',
  'after.provider-settle': 'settled',
} as const satisfies Record<string, BriefWriteGuard>;

export type BriefWriteSite = keyof typeof BRIEF_WRITE_RULES;

/** Why a write was withheld; reported as the brief's reason. */
export type BriefWriteWithheld = 'worktree_changed' | 'lifetime_unpinned' | 'incarnation_changed';

/**
 * The rule (D2 design §20.1): whether a write of this guard may be made. Pure; the reads are the caller's.
 * `continuity` is {@link briefWorktreeContinuity} of the request's pin (`unknown` without one).
 */
export function briefWriteVerdict(
  guard: BriefWriteGuard,
  pinned: boolean,
  continuity: 'same' | 'changed' | 'unknown',
  instanceAsPinned: () => boolean
): BriefWriteWithheld | 'write' {
  if (guard === 'entrance' || guard === 'settled') return 'write';
  if (guard === 'reset') {
    if (continuity === 'changed') return 'worktree_changed';
    return pinned && continuity !== 'same' ? 'lifetime_unpinned' : 'write';
  }
  if (continuity === 'changed') return 'worktree_changed';
  if (continuity !== 'same') return 'lifetime_unpinned';
  if (guard === 'same-and-instance' && !instanceAsPinned()) return 'incarnation_changed';
  return 'write';
}

/** The entrance's write (`entrance` guard): before a pin exists. */
function writeAtEntrance<T>(site: BriefWriteSite, write: () => T): T {
  if (BRIEF_WRITE_RULES[site] !== 'entrance') throw new Error(`not an entrance write: ${site}`);
  return write();
}

/** This process. A claim another process left behind is read as `unknown` (design §3.5). */
const PROCESS_NONCE = randomUUID();
/**
 * Claims a send of this process holds right now. pr3f (PM decision 3): a strict claim whose putting
 * back (`not_sent` → `pending`) failed stays here, so the next strict send of this process finds it
 * `claimed` (409) instead of recovering it as `unknown` (used up, never typed). After a restart the
 * recovery reads it `unknown` (design §3.2, a risk kept).
 */
const liveClaims = new Set<string>();

let writeVerdictOverride: ((site: BriefWriteSite) => BriefWriteWithheld | null) | undefined;

/** pr3f (test seam): withhold a site's write as the gate would (null: the gate decides). */
export function setBriefWriteVerdictForTest(override: ((site: BriefWriteSite) => BriefWriteWithheld | null) | undefined): void {
  writeVerdictOverride = override;
}

let memTargetDepsOverride: MemTargetDeps | undefined;

/** Hand `withMemTarget` its git and path probes in a test. */
export function setBriefMemTargetDepsForTest(deps: MemTargetDeps | undefined): void {
  memTargetDepsOverride = deps;
}

const bytesOf = (text: string): number => Buffer.byteLength(text, 'utf8');
const newlinesOf = (text: string): number => text.split('\n').length - 1;
/** Lines as #2464 counts them: newlines + 1. */
export const linesOf = (text: string): number => newlinesOf(text) + 1;

/**
 * The budget a provider gets (design §6.2): what is left of #2464's verified size
 * once the operator's body, the separator and the tool's own additions (an image
 * reference) are counted.
 */
export function briefBudget(
  typedBody: (content: string) => string,
  content: string,
  provider: Pick<BriefProvider, 'defaultBytes'>,
  detail?: BriefDetail
): { maxBytes: number; maxLines: number } {
  const base = typedBody(BRIEF_SEPARATOR + content);
  // Issue #4227 (S-B, S-F): `full` asks C's text maximum, still within #2464's verified size.
  const cap = detail === 'full' ? BRIEF_BUDGET.text.max : provider.defaultBytes;
  return {
    maxBytes: Math.min(cap, SEND_VERIFIED_MAX_BYTES - bytesOf(base)),
    maxLines: SEND_VERIFIED_MAX_LINES - newlinesOf(base),
  };
}

/** Whether the final typed text, brief included, is within #2464's verified size. */
export function withinVerifiedSize(finalTyped: string): boolean {
  return bytesOf(finalTyped) <= SEND_VERIFIED_MAX_BYTES && linesOf(finalTyped) <= SEND_VERIFIED_MAX_LINES;
}

/** Re-exported for the send's callers and tests (the rule lives with the ledger). */
export const sameInstanceLifetime = isSameInstanceLifetime;

function membershipKey(target: Extract<MemTarget, { ok: true }>): string {
  return JSON.stringify([
    target.storageRepositoryId,
    [...target.readRepositoryIds].sort(),
    target.branch,
    target.detached,
    target.mode,
    target.features.injectOnStart,
  ]);
}

function outcomeOf(state: SendAttemptState): BoundaryOutcome {
  return state === 'sent' ? 'sent' : state === 'not-sent' ? 'not_sent' : 'unknown';
}

async function buildWithTimeout(provider: BriefProvider, request: Parameters<BriefProvider['build']>[0]): Promise<BriefResult> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('brief provider timed out')), BRIEF_PROVIDER_TIMEOUT_MS);
    timer.unref?.();
  });
  try {
    return await Promise.race([Promise.resolve(provider.build(request)), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

interface PlannedBoundary {
  id: string;
  kind: BriefBoundaryKind;
  late: boolean;
  openedAt: number;
  /** false: `force` with no pending row; the explicit row is opened when claimed. */
  existing: boolean;
}

interface Plan {
  boundary: PlannedBoundary;
  lifetime: InstanceLifetime;
  /** The worktree incarnation the provider built for (D2 design §2.4). */
  worktreeIncarnation: string;
  membershipKey: string;
  provider: BriefProvider;
  built: BriefResult;
  claimToken: string;
  /**
   * Issue #4227 (S-B): a claim that attaches nothing — `declined` (the screen's "don't read") or,
   * pr3f, `empty` (`full`'s brief came out empty). The row is claimed before the body and used up as
   * `skipped(<this>)` once it went in; null: the brief is attached.
   */
  skipAs: 'declined' | 'empty' | null;
}

/** Issue #4227 (pr3e): what a strict plan read, for the final reading's one predicate. */
interface StrictSeen {
  /** The shown row as the plan read it: still `pending`, or used up (`sent`・`skipped`・`unknown`). */
  state: 'pending' | 'used_up';
  membershipKey: string;
  worktreeIncarnation: string;
}

/** What the plan's synchronous stretch decided: a target to build for, and the worktree incarnation. */
interface PlanDecision {
  target: Extract<MemTarget, { ok: true }> & { mode: Exclude<MemMode, 'off'> };
  worktreeIncarnation: string;
}

export interface SendBriefInput {
  db: unknown;
  worktreeId: string;
  cliToolId: string;
  /** Resolved (`instanceId ?? cliToolId`). */
  instanceId: string;
  mode: BriefSendMode;
  /** The operator's body, as validated. */
  content: string;
  /** What the tool types for a body (an image reference appended, `typedBodyFor`). */
  typedBody: (content: string) => string;
  /**
   * Issue #4224: the lifetimes the request's entrance fixed ({@link pinBriefRequest}). Required
   * for `auto` / `force` (the service's type says so); null or another target's: no brief.
   */
  pin?: BriefRequestPin | null;
  /** Issue #4227 (S-B): with `auto`, `full` asks the whole brief (C's `itemCap:false`). Absent: `short`. */
  detail?: BriefDetail;
  /**
   * Issue #4227 (S-B, design §3.2): the boundary the screen's preview showed. A `full` / `decline`
   * send acts on it only while it is the instance's current, `pending` row; otherwise it stops
   * before any key ({@link BriefChoiceAbortedError}).
   */
  boundaryId?: string;
}

/**
 * One send's brief. Every method fails open for `auto` / `skip` / `force` (D1): a ledger error costs a
 * log line, never the send. Issue #4227 (pr3f, S-B-commit): a strict choice (`full` / `decline`) does
 * not go through those parts at the claim — it goes {@link SendBrief.claim} → the final reading →
 * `commitStrict`, whose one answer is the text to type or the abort, and every failure is the abort.
 */
export class SendBrief {
  private readonly db: Database.Database | null;
  private readonly supported: boolean;
  private readonly entryLifetime: InstanceLifetime | null;
  private readonly pin: BriefRequestPin | null;
  private planCalled = false;
  private planned: Plan | null = null;
  private claimed: { body: string; includedNoticeIds: string[] } | null = null;
  private reserved: { includedNoticeIds: string[] } | null = null;
  private settled: BoundaryOutcome | null = null;
  private report: BriefReport | null = null;
  /**
   * Issue #4227 (S-B, pr3f): the reason a strict choice's plan stopped (the first one wins). The plan's
   * outcome, nothing more: the claim turns it into its abort before any reading or write
   * ({@link strictOutcome} → `refused`), and the claim itself never sets it.
   */
  private planAbort: string | null = null;
  /**
   * Issue #4227 (S-B, pr3d): the plan's named way out for a strict choice that holds no abort and no
   * plan (`planned` / `empty` / `refused` are read from those, {@link strictOutcome}). Never the
   * answer: the claim reads the current row again first (design §3.2).
   */
  private strictPlan: Extract<StrictPlanOutcome, 'used_up'> | null = null;
  /**
   * Issue #4227 (S-B, pr3e): what the plan of a strict choice read — the shown row's state (still
   * `pending`, or used up), the membership and settings it was read under, and the worktree
   * incarnation — for every outcome but `refused`. The final reading ({@link finalReading}) holds
   * the instance's current row to all of it, whichever the outcome.
   */
  private strictSeen: StrictSeen | null = null;

  /**
   * Issue #4227 (pr3d): the plan's outcome for a strict choice — decided by none of it. A way out of
   * the plan that named nothing is `refused` (fail-closed: the claim types nothing). Null otherwise.
   */
  private strictOutcome(): StrictPlanOutcome | null {
    if (!this.strict) return null;
    if (this.planAbort !== null) return 'refused';
    if (this.planned) return this.planned.skipAs === 'empty' ? 'empty' : 'planned';
    return this.strictPlan ?? 'refused';
  }
  readonly isReset: boolean;

  constructor(private readonly input: SendBriefInput) {
    this.db = boundaryDatabaseFor(input.db);
    this.supported = this.db !== null && BOUNDARY_TOOLS.has(input.cliToolId);
    this.isReset = this.supported && isResetCommandBody(input.cliToolId, input.content);
    const pin = input.pin ?? null;
    this.pin = pin && pin.worktreeId === input.worktreeId && pin.instanceId === input.instanceId ? pin : null;
    let lifetime: InstanceLifetime | null = this.pin ? this.pin.instance : null;
    if (this.supported && this.isReset && !this.pin) {
      // Read before the first await: a reset typed for an instance deleted and made
      // again meanwhile does not open a row of the new one.
      try {
        lifetime = readInstanceLifetime(this.db!, input.worktreeId, input.instanceId);
      } catch (error) {
        this.warn('session-brief-lifetime-read-failed', error);
      }
    }
    this.entryLifetime = lifetime;
  }

  private warn(event: string, error: unknown): void {
    logger.warn(event, {
      worktreeId: this.input.worktreeId,
      instanceId: this.input.instanceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  /**
   * Issue #4227 (S-B, design §3.2): a choice the screen made for one boundary (`full`, `decline`).
   * Whatever would leave it unbriefed or used up stops the send instead — nothing is written,
   * nothing typed — so the operator is asked again; `auto` / `skip` / `force` are as before.
   */
  private get strict(): boolean {
    return this.input.mode === 'decline' || (this.input.mode === 'auto' && this.input.detail === 'full');
  }

  /** Issue #4227: a strict choice's plan stops here (the first reason wins). Writes nothing. */
  private refuse(reason: string): void {
    if (this.planAbort === null) this.planAbort = reason;
  }

  /** Issue #4227 (pr3f): the error a strict abort is thrown as. Reads the shown row's state now. */
  private abortError(reason: string): BriefChoiceAbortedError {
    let boundary: { id: string; state: BoundaryState } | null = null;
    const shown = this.input.boundaryId;
    if (shown && this.db) {
      try {
        const row = getBoundaryById(this.db, shown);
        if (row && row.worktreeId === this.input.worktreeId && row.instanceId === this.input.instanceId) {
          boundary = { id: row.id, state: row.state };
        }
      } catch (error) {
        this.warn('session-brief-abort-read-failed', error);
      }
    }
    return new BriefChoiceAbortedError(reason, boundary);
  }

  /**
   * A skipped report — or, for a strict choice's plan, its stop (Issue #4227). Writes nothing.
   * pr3f: never reached by a strict claim (the commit answers its own aborts).
   */
  private skipped(reason: string, rowId: string | null): void {
    if (this.strict) return this.refuse(reason);
    this.report = { state: 'skipped', reason, ...(rowId ? { boundaryId: rowId } : {}) };
  }

  /**
   * The one gate every write of a send goes through (D2 design §20): the site's guard from
   * {@link BRIEF_WRITE_RULES}, read in the caller's synchronous stretch. Withheld: nothing is
   * written, and the reason is answered for the caller to report (fail-closed).
   */
  private write(site: BriefWriteSite, db: Database.Database, write: () => void): BriefWriteWithheld | 'write' {
    const verdict = writeVerdictOverride?.(site) ?? briefWriteVerdict(BRIEF_WRITE_RULES[site], this.pin !== null, this.continuity(db), () => this.instanceAsPinned(db));
    if (verdict !== 'write') {
      logger.info('session-brief-write-withheld', { worktreeId: this.input.worktreeId, instanceId: this.input.instanceId, site, verdict });
      return verdict;
    }
    write();
    return 'write';
  }

  /**
   * Consumes the row (under the site's guard) and reports the reason. The send's own flag is
   * reported whatever happened; `auto` only when something was attached. A withheld write
   * reports why nothing was written instead.
   */
  private skip(rowId: string | null, reason: BoundarySkipReason | 'no_brief' | 'settings_changed' | 'reservation_conflict', site: BriefWriteSite): void {
    // Issue #4227 (S-B, pr3f): a strict choice's plan uses nothing up — `empty` included (its row is
    // claimed and settled by the commit, never here). Its way out is the plan's stop.
    if (this.strict) return this.refuse(reason);
    if (rowId !== null && this.db) {
      const db = this.db;
      let verdict: BriefWriteWithheld | 'write' = 'write';
      try {
        verdict = this.write(site, db, () => skipBoundary(db, rowId, reason as BoundarySkipReason, Date.now()));
      } catch (error) {
        this.warn('session-brief-skip-failed', error);
      }
      if (verdict !== 'write') {
        this.report = { state: 'skipped', reason: verdict, boundaryId: rowId };
        return;
      }
    }
    this.report = { state: 'skipped', reason, ...(rowId ? { boundaryId: rowId } : {}) };
  }

  /**
   * Whether the delivery must run under the outer input lock (a claim to make, a reset to record,
   * or — pr3d — a strict choice's final reading, which counts only right before the body).
   */
  needsOuterLock(): boolean {
    return this.planned !== null || this.isReset || (this.strictOutcome() ?? 'refused') !== 'refused';
  }

  /** Whether the pinned worktree is still the one found (`unknown` without a pin's evidence). */
  private continuity(db: Database.Database): 'same' | 'changed' | 'unknown' {
    return this.pin ? briefWorktreeContinuity(db, this.pin) : 'unknown';
  }

  /**
   * Whether the instance is still the lifetime the request's entrance pinned (PM review P3-1).
   * When it is not, the request writes nothing on the instance's rows — not a stale claim's
   * settlement either (Codex re-review P2): they may be the new instance's.
   */
  private instanceAsPinned(db: Database.Database): boolean {
    return sameInstanceLifetime(this.pin!.instance, readInstanceLifetime(db, this.input.worktreeId, this.input.instanceId), this.input.cliToolId);
  }

  /**
   * Whether the row records the pinned incarnation (either side null: not compared, so a
   * lazily issued row is not broken). Asked only once the instance is found as pinned: a row
   * of an older incarnation is then a dead instance's remainder, consumed as
   * `incarnation_changed` (PM re-review P3).
   */
  private rowOfPinnedIncarnation(row: { instanceIncarnation: string | null }): boolean {
    const pinned = this.pin!.instance;
    return row.instanceIncarnation === null || pinned.incarnation === null || row.instanceIncarnation === pinned.incarnation;
  }

  /** The worktree was deleted, made again or renamed after the request's entrance: nothing is written. */
  private worktreeChanged(rowId: string | null): void {
    this.skipped('worktree_changed', rowId);
  }

  /** Step 1 (design §3.4 1). A second call does nothing (D2 design §3.3 (c)). */
  async plan(): Promise<void> {
    if (this.planCalled) return;
    this.planCalled = true;
    const { mode, content, worktreeId, instanceId, cliToolId } = this.input;
    if (mode === 'never') return;
    if (!this.supported || !this.db) {
      if (this.strict) this.refuse('unsupported');
      else if (mode !== 'auto') this.report = { state: 'skipped', reason: 'unsupported' };
      return;
    }
    // A command with words in front of it is no command (a reset still opens its row, step 3).
    if (isSlashCommandBody(content)) {
      // Issue #4227 (pr3f, PM decision 5): a strict choice is never made for a command — the route
      // answers 400, and the service stops before anything is read or written (nothing typed).
      if (this.strict) return this.refuse('slash_command');
      if (mode !== 'auto') this.report = { state: 'skipped', reason: 'slash_command' };
      return;
    }
    if (mode === 'skip') {
      // `--no-brief`: this one send only; the boundary stays pending.
      this.report = { state: 'skipped', reason: 'no_brief' };
      return;
    }
    const db = this.db;
    const pin = this.pin;
    if (!pin) {
      this.skipped('lifetime_unpinned', null);
      return;
    }
    let boundary: PlannedBoundary;
    let lifetime: InstanceLifetime;
    // pr3e: the shown row's state as a strict plan read it (the final reading's condition).
    let seenState: StrictSeen['state'] = 'pending';
    try {
      // Before any read a write follows (D2 design §2.4 W3): not for a worktree made again.
      if (this.continuity(db) === 'changed') return this.worktreeChanged(null);
      let current = getCurrentBoundary(db, worktreeId, instanceId);
      // The instance's lifetime as the entrance read it (W1): never read again here.
      lifetime = pin.instance;
      if (current && (current.state === 'pending' || current.state === 'claimed') && !this.instanceAsPinned(db)) {
        // Issue #4224 (PM review P3-1, Codex re-review P2; the instance's W1・W3): the instance
        // was deleted and made again after the entrance, and the row may be the new one's
        // launch. The old request neither attaches, consumes nor settles it (a stale claim
        // included): the new conversation's first request does.
        this.skipped('incarnation_changed', current.id);
        return;
      }
      if (current?.state === 'claimed' && current.claimToken !== null && !liveClaims.has(current.claimToken)) {
        const stale = current;
        const settled = this.write('plan.stale-claim', db, () => settleStaleClaim(db, stale.id, stale.claimToken!, Date.now()));
        if (settled !== 'write') {
          // D2 design §20: a pin without evidence (`unknown`) settles nothing either.
          this.skipped(settled, stale.id);
          return;
        }
        current = getBoundaryById(db, current.id);
      }
      if (this.strict) {
        // Issue #4227 (S-B, design §3.2): only the row the screen showed, while it is the current
        // one and `pending`. Another current row (reset, relaunch): `superseded`. Held by another
        // send's live claim: `claimed` (not used up — it may come back). Used up: body only.
        if (!current || current.id !== this.input.boundaryId || current.state === 'superseded') {
          this.refuse('superseded');
          return;
        }
        if (current.state === 'claimed') {
          this.refuse('claimed');
          return;
        }
        // pr3e: whatever the outcome (a command, used up, to be briefed), the plan reads what the
        // final reading holds the row to — the row's instance, the membership and the settings.
        if (!this.rowOfPinnedIncarnation(current)) {
          this.refuse('incarnation_changed');
          return;
        }
        // pr3c (codex P2-1): used up is not decided here — the claim's final reading decides (pr3d).
        seenState = current.state === 'pending' ? 'pending' : 'used_up';
      }
      const usable =
        current !== null &&
        (current.state === 'pending' || (current.state === 'claimed' && current.claimToken !== null && liveClaims.has(current.claimToken)));
      if (usable && current && !this.rowOfPinnedIncarnation(current)) {
        // PM re-review P3: the instance is the one pinned, the row a dead incarnation's launch.
        // The new request does not leave it as the current row: consumed as before P3-1 — only
        // when the worktree is proven `same` (Codex re-review 2 P2, D2 design §20).
        this.skip(current.id, 'incarnation_changed', 'plan.dead-row');
        return;
      }
      if (this.strict && current) {
        boundary = { id: current.id, kind: current.kind, late: current.late, openedAt: current.openedAt, existing: true };
      } else if (usable && current) {
        boundary = { id: current.id, kind: current.kind, late: current.late, openedAt: current.openedAt, existing: true };
      } else if (mode === 'force') {
        boundary = { id: randomUUID(), kind: 'explicit', late: false, openedAt: Date.now(), existing: false };
      } else {
        return;
      }
    } catch (error) {
      this.warn('session-brief-plan-read-failed', error);
      if (this.strict) this.refuse('claim_failed');
      return;
    }
    const rowId = boundary.existing ? boundary.id : null;

    // Issue #4224: what the answer decides is written in its synchronous stretch, after the
    // pinned worktree is found to be the same (W3); the incarnation is made only for a
    // `derived` / `on` target with `injectOnStart` (W5).
    let decided: PlanDecision | null;
    try {
      decided = await withMemTarget(db, { via: 'worktree', worktreeId }, memTargetDepsOverride ?? {}, (resolved) =>
        this.planInStretch(db, pin, rowId, resolved)
      );
    } catch (error) {
      this.warn('session-brief-target-failed', error);
      if (this.continuity(db) === 'changed') return this.worktreeChanged(rowId);
      this.skip(rowId, 'target_unresolved', 'plan.consume');
      return;
    }
    if (!decided) return;
    const { target, worktreeIncarnation } = decided;
    if (this.strict) {
      // pr3e: the plan's reading, for the one predicate of the final reading (design §3.2).
      this.strictSeen = { state: seenState, membershipKey: membershipKey(target), worktreeIncarnation };
      if (seenState === 'used_up') {
        this.strictPlan = 'used_up';
        return;
      }
    }

    const provider = getBriefProvider();
    if (mode === 'decline') {
      // Issue #4227 (S-B): nothing is built; the claim reserves the row and the outcome uses it up.
      this.planned = {
        boundary,
        lifetime,
        worktreeIncarnation,
        membershipKey: membershipKey(target),
        provider,
        built: { body: '', includedNoticeIds: [], mode: target.mode },
        claimToken: `${PROCESS_NONCE}:${randomUUID()}`,
        skipAs: 'declined',
      };
      return;
    }
    const budget = briefBudget(this.input.typedBody, content, provider, this.input.detail);
    if (budget.maxBytes < provider.minBytes || budget.maxLines < 1) return this.skip(rowId, 'over_limit', 'plan.consume');

    let built: BriefResult;
    try {
      built = await buildWithTimeout(provider, {
        target: {
          worktreeId,
          worktreeIncarnation,
          cliToolId: cliToolId as Parameters<BriefProvider['build']>[0]['target']['cliToolId'],
          instanceId,
          instanceIncarnation: lifetime.incarnation,
          instanceOnRoster: lifetime.onRoster,
        },
        membership: {
          repositoryId: target.storageRepositoryId,
          readRepositoryIds: [...target.readRepositoryIds],
          branch: target.branch,
          detached: target.detached,
          mode: target.mode,
        },
        boundary: { id: boundary.id, kind: boundary.kind, late: boundary.late, openedAt: boundary.openedAt },
        budget,
        // Issue #4227 (S-F): only `full` is told; `short` asks exactly what it asked before.
        ...(this.input.detail === 'full' ? { detail: 'full' as const } : {}),
        now: Date.now(),
      });
    } catch (error) {
      this.warn('session-brief-provider-failed', error);
      if (this.continuity(db) === 'changed') return this.worktreeChanged(rowId);
      return this.skip(rowId, 'provider_failed', 'plan.consume');
    }
    // The build waited: a worktree made again meanwhile gets none of these writes.
    if (this.continuity(db) === 'changed') return this.worktreeChanged(rowId);
    if (!built || typeof built.body !== 'string' || built.mode !== target.mode || !Array.isArray(built.includedNoticeIds)) {
      return this.skip(rowId, 'provider_failed', 'plan.consume');
    }
    // D2 design §7.4: a line the brief must carry did not fit — recorded, the body is sent.
    if (built.body === '' && built.skipReason === 'over_limit') return this.skip(rowId, 'over_limit', 'plan.consume');
    if (built.body === '') {
      // pr3d (codex P2, review-4227-pr3b): a strict `full` does not use the row up here — the
      // claim's final reading does, once the shown row is found still the current one. pr3f: as a
      // `decline` is — claimed by the commit, settled `skipped(empty)` once the body went in.
      if (this.strict) {
        this.planned = {
          boundary,
          lifetime,
          worktreeIncarnation,
          membershipKey: membershipKey(target),
          provider,
          built: { body: '', includedNoticeIds: [], mode: target.mode },
          claimToken: `${PROCESS_NONCE}:${randomUUID()}`,
          skipAs: 'empty',
        };
        return;
      }
      return this.skip(rowId, 'empty', 'plan.consume');
    }
    if (bytesOf(built.body) > budget.maxBytes || linesOf(built.body) > budget.maxLines) {
      return this.skip(rowId, 'over_limit', 'plan.consume');
    }
    if (!withinVerifiedSize(this.input.typedBody(built.body + BRIEF_SEPARATOR + content))) {
      return this.skip(rowId, 'over_limit', 'plan.consume');
    }
    this.planned = {
      boundary,
      lifetime,
      worktreeIncarnation,
      membershipKey: membershipKey(target),
      provider,
      built: { body: built.body, includedNoticeIds: [...built.includedNoticeIds], mode: built.mode },
      claimToken: `${PROCESS_NONCE}:${randomUUID()}`,
      skipAs: null,
    };
  }

  /**
   * The plan's synchronous stretch (Issue #4224, W3・W5): the pinned worktree still the one
   * found, then the membership's answer, and the worktree incarnation the provider builds for.
   */
  private planInStretch(
    db: Database.Database,
    pin: BriefRequestPin,
    rowId: string | null,
    target: MemTarget
  ): PlanDecision | null {
    const continuity = briefWorktreeContinuity(db, pin);
    if (continuity === 'changed') {
      this.worktreeChanged(rowId);
      return null;
    }
    if (!target.ok) {
      this.skip(rowId, 'target_unresolved', 'plan.consume');
      return null;
    }
    if (target.mode === 'off') {
      this.skip(rowId, 'off', 'plan.consume');
      return null;
    }
    if (!target.features.injectOnStart) {
      this.skip(rowId, 'disabled', 'plan.consume');
      return null;
    }
    let worktreeIncarnation: string | null = null;
    const made = this.write('plan.incarnation', db, () => {
      worktreeIncarnation = getOrCreateWorktreeIncarnation(db, this.input.worktreeId);
    });
    if (made !== 'write' || worktreeIncarnation === null) {
      // No evidence the worktree read at the entrance is this one (`unknown`): none attached,
      // nothing written — not the incarnation either (D2 design §20). The row stays for the next
      // request, whose entrance finds the row (or makes the incarnation) and is pinned.
      this.skipped(made === 'write' ? 'lifetime_unpinned' : made, rowId);
      return null;
    }
    return { target: { ...target, mode: target.mode }, worktreeIncarnation };
  }

  /** The claim token a relaunch inside this send's delivery is tagged with. */
  claimTokenForScope(): string | null {
    return this.claimed && this.planned ? this.planned.claimToken : null;
  }

  /**
   * Step 2 (design §3.4 3): under the input lock, right before the body is typed.
   * Answers the text to type — the brief in front of the body, or the body alone.
   */
  async claim(): Promise<string> {
    // Issue #4227 (S-B, design §3.2, pr3d/pr3e — the invariant): a strict choice is read again by
    // the one predicate first, whatever the plan found; only then does the plan's outcome count.
    if (this.strict) return this.claimStrict();
    const plan = this.planned;
    const db = this.db;
    if (!plan || !db) return this.input.content;
    let body: string | null;
    try {
      body = await withMemTarget(db, { via: 'worktree', worktreeId: this.input.worktreeId }, memTargetDepsOverride ?? {}, (target) =>
        this.claimInStretch(db, plan, target)
      );
    } catch (error) {
      this.warn('session-brief-claim-failed', error);
      return this.input.content;
    }
    if (body === null) return this.input.content;
    return body + BRIEF_SEPARATOR + this.input.content;
  }

  /**
   * Issue #4227 (S-B, design §3.2 — pr3f, the invariant S-B-commit): a strict choice's claim, one
   * road. Under the input lock, right before the body, in one synchronous stretch of `withMemTarget`:
   * the final reading's one predicate ({@link finalReading}), then {@link commitStrict}; the `text` of
   * its answer is what is typed — nothing else is. An abort (any failure) is thrown: nothing typed,
   * the shown row as it was.
   */
  private async claimStrict(): Promise<string> {
    const commit = await this.commitInFinalStretch();
    if (commit.type === 'type') return commit.text;
    throw this.abortError(commit.reason);
  }

  /**
   * pr3f: the commit's one answer. The plan's stop is the abort before anything is read
   * (`refused`, its reason first); a throw anywhere, or an answer that is not exactly a commit, is
   * `claim_failed`. A claim made before an abort goes back (`not_sent`).
   */
  private async commitInFinalStretch(): Promise<StrictCommit> {
    const db = this.db;
    const outcome = this.strictOutcome();
    if (!db || outcome === null) return abort('claim_failed');
    if (outcome === 'refused') return abort(this.planAbort ?? 'claim_failed');
    const kind = strictKindOf(outcome, this.planned?.skipAs === 'declined');
    let answer: unknown;
    try {
      answer = await withMemTarget(db, { via: 'worktree', worktreeId: this.input.worktreeId }, memTargetDepsOverride ?? {}, (target) =>
        this.finalStretch(db, kind, target)
      );
    } catch (error) {
      this.warn('session-brief-claim-failed', error);
      answer = abort('claim_failed');
    }
    const commit: StrictCommit = isStrictCommit(answer) ? answer : abort('claim_failed');
    if (commit.type === 'abort' && this.claimed && this.planned) this.unclaim(db, this.planned);
    return commit;
  }

  /** pr3f: `withMemTarget`'s synchronous stretch — the predicate, then the commit. Never throws. */
  private finalStretch(db: Database.Database, kind: StrictKind, target: MemTarget): StrictCommit {
    try {
      const reading = this.finalReading(db, target);
      if (reading.type === 'abort') return reading;
      return this.commitStrict(db, kind, reading.row);
    } catch (error) {
      this.warn('session-brief-claim-failed', error);
      return abort('claim_failed');
    }
  }

  /**
   * Issue #4227 (S-B, design §3.2 — the final reading's one predicate, pr3e). Every plan outcome of
   * a strict choice is held to all of it; the first condition that fails is the abort's reason:
   *  1. the worktree it belongs to: the pinned worktree is still the one found, with the incarnation
   *     the plan read (`worktree_changed`);
   *  2. the settings: the membership resolves, and its mode, `injectOnStart` and membership are what
   *     the plan read (`off`, `disabled`, otherwise `settings_changed`);
   *  3. the identity: the shown row is the instance's current row and not `superseded` (`superseded`);
   *  4. the instance it belongs to: the instance is the lifetime the entrance pinned, and the row is
   *     that lifetime's (`incarnation_changed`);
   *  5. the state: as the plan read it — `pending` still `pending`, used up still used up; held by
   *     another send's claim, or taken meanwhile: `claimed`; back to `pending`: `superseded`.
   * Reads only; answers the current row (pr3f: one value, the row or the abort).
   */
  private finalReading(db: Database.Database, target: MemTarget): { type: 'pass'; row: BoundaryRow } | StrictAbort {
    const seen = this.strictSeen;
    const pin = this.pin;
    if (!seen || !pin) return abort('claim_failed');
    const { worktreeId, instanceId, cliToolId } = this.input;
    if (this.continuity(db) !== 'same' || getWorktreeIncarnation(db, worktreeId) !== seen.worktreeIncarnation) {
      return abort('worktree_changed');
    }
    if (!target.ok || membershipKey(target) !== seen.membershipKey) {
      return abort(target.ok && target.mode === 'off' ? 'off' : target.ok && !target.features.injectOnStart ? 'disabled' : 'settings_changed');
    }
    const current = getCurrentBoundary(db, worktreeId, instanceId);
    if (!current || current.id !== this.input.boundaryId || current.state === 'superseded') return abort('superseded');
    const now = readInstanceLifetime(db, worktreeId, instanceId);
    if (
      !sameInstanceLifetime(pin.instance, now, cliToolId) ||
      !sameInstanceLifetime({ incarnation: current.instanceIncarnation, onRoster: current.onRoster }, now, cliToolId)
    ) {
      return abort('incarnation_changed');
    }
    const usedUp = current.state !== 'pending';
    if (current.state === 'claimed' || (seen.state === 'pending' && usedUp)) return abort('claimed');
    if (seen.state === 'used_up' && !usedUp) return abort('superseded');
    return { type: 'pass', row: current };
  }

  /**
   * Issue #4227 (pr3f, the invariant S-B-commit): what the kind does once the final reading held,
   * from {@link STRICT_COMMIT_RULES}. One answer: the text to type, built here and nowhere else, or
   * the abort. Nothing is used up before the body: the most it writes is `claimed` (this send's
   * token), and any write that throws, changes no row, is withheld, or a reservation that answers
   * nothing, is the abort (nothing typed, the row as it was). The report is the commit's result.
   */
  private commitStrict(db: Database.Database, kind: StrictKind, row: BoundaryRow): StrictCommit {
    const rule: StrictCommitRule = STRICT_COMMIT_RULES[kind];
    const content = this.input.content;
    if (rule.settle === null) {
      // Used up by another send: nothing written, the body alone, said `consumed`.
      this.report = { state: 'consumed', boundaryId: row.id };
      return { type: 'type', text: content };
    }
    const plan = this.planned;
    if (!plan || plan.boundary.id !== row.id) return abort('claim_failed');
    let brief = { body: plan.built.body, includedNoticeIds: [...plan.built.includedNoticeIds] };
    if (rule.writes.includes('claim.reserve') && plan.provider.reserve) {
      const reserved = this.reserveStrict(db, plan);
      if (reserved.type === 'abort') return reserved;
      brief = reserved.brief;
    }
    if (rule.typed === 'brief_and_body' && brief.body === '') return abort('claim_failed');
    const claimed = this.claimRowStrict(db, plan, row);
    if (claimed !== 'claimed') return claimed;
    liveClaims.add(plan.claimToken);
    this.claimed = brief;
    return { type: 'type', text: rule.typed === 'brief_and_body' ? brief.body + BRIEF_SEPARATOR + content : content };
  }

  /**
   * pr3f: the provider's reservation for a strict `full`. A throw is `claim_failed`, withheld its
   * verdict, an answer of nothing (or one that no longer fits) `reservation_conflict`. Once the
   * provider answered, what it took is told back `discarded` unless this send's claim keeps it.
   */
  private reserveStrict(db: Database.Database, plan: Plan): { type: 'reserved'; brief: { body: string; includedNoticeIds: string[] } } | StrictAbort {
    const provider = plan.provider;
    let answer: unknown = null;
    let verdict: BriefWriteWithheld | 'write';
    try {
      verdict = this.write('claim.reserve', db, () => {
        answer = provider.reserve!({
          boundaryId: plan.boundary.id,
          claimToken: plan.claimToken,
          includedNoticeIds: [...plan.built.includedNoticeIds],
          body: plan.built.body,
        });
      });
    } catch (error) {
      this.warn('session-brief-reserve-failed', error);
      return abort('claim_failed');
    }
    if (verdict !== 'write') return abort(verdict);
    this.reserved = { includedNoticeIds: [...plan.built.includedNoticeIds] };
    const reserved = answer as { body?: unknown; includedNoticeIds?: unknown } | null;
    if (
      !reserved ||
      typeof reserved.body !== 'string' ||
      reserved.body === '' ||
      !Array.isArray(reserved.includedNoticeIds) ||
      !withinVerifiedSize(this.input.typedBody(reserved.body + BRIEF_SEPARATOR + this.input.content))
    ) {
      return abort('reservation_conflict');
    }
    return { type: 'reserved', brief: { body: reserved.body, includedNoticeIds: reserved.includedNoticeIds.map(String) } };
  }

  /**
   * pr3f: claim the shown row in one transaction (its incarnation filled when it had none, then the
   * claim). A write that changes no row rolls the other back; a throw, too. Either is the abort.
   */
  private claimRowStrict(db: Database.Database, plan: Plan, row: BoundaryRow): 'claimed' | StrictAbort {
    const { worktreeId, instanceId } = this.input;
    let claimed = false;
    let verdict: BriefWriteWithheld | 'write';
    try {
      verdict = this.write('claim.row', db, () => {
        const now = readInstanceLifetime(db, worktreeId, instanceId);
        claimed = db.transaction((): boolean => {
          let incarnation = row.instanceIncarnation;
          if (incarnation === null && now.incarnation !== null) {
            if (fillBoundaryIncarnation(db, row.id, now.incarnation) !== true) throw new ClaimRolledBack();
            incarnation = now.incarnation;
          }
          if (claimBoundary(db, row.id, plan.claimToken, incarnation) !== true) throw new ClaimRolledBack();
          return true;
        })();
      });
    } catch (error) {
      if (!(error instanceof ClaimRolledBack)) this.warn('session-brief-claim-failed', error);
      return abort('claim_failed');
    }
    if (verdict !== 'write') return abort(verdict);
    return claimed ? 'claimed' : abort('claim_failed');
  }

  /**
   * Issue #4227: a claim this send made but will not type under goes back (`not_sent`). pr3f (PM
   * decision 3): when that fails, the claim stays this process's ({@link liveClaims}).
   */
  private unclaim(db: Database.Database, plan: Plan): void {
    if (!this.claimed) return;
    let putBack = false;
    try {
      this.write('settle.claim', db, () => {
        putBack = settleBoundaryClaim(db, plan.boundary.id, plan.claimToken, 'not_sent', null, Date.now());
      });
    } catch (error) {
      this.warn('session-brief-unclaim-failed', error);
    } finally {
      if (putBack) liveClaims.delete(plan.claimToken);
      this.claimed = null;
    }
  }

  /**
   * The synchronous stretch `withMemTarget` settled the membership in. Returns the brief, or null.
   * D1's (`auto` / `force`): fails open. pr3f: a strict choice never comes here ({@link commitStrict}).
   */
  private claimInStretch(db: Database.Database, plan: Plan, target: MemTarget): string | null {
    const { worktreeId, instanceId, cliToolId } = this.input;
    const rowId = plan.boundary.existing ? plan.boundary.id : null;
    // Issue #4224 (W3・W4): the worktree the request was read for, and the incarnation the
    // provider built for, before anything is written — `force` opens its row only after.
    if (this.continuity(db) !== 'same' || getWorktreeIncarnation(db, worktreeId) !== plan.worktreeIncarnation) {
      this.worktreeChanged(rowId);
      return null;
    }
    if (!target.ok || membershipKey(target) !== plan.membershipKey) {
      // Changed while the provider or the lock was waited for: not with the old text.
      if (target.ok && target.mode === 'off') this.skip(rowId, 'off', 'claim.consume');
      else if (target.ok && !target.features.injectOnStart) this.skip(rowId, 'disabled', 'claim.consume');
      this.skipped('settings_changed', rowId);
      return null;
    }
    const now = readInstanceLifetime(db, worktreeId, instanceId);
    let rowIncarnation = plan.lifetime.incarnation;
    if (plan.boundary.existing) {
      const row = getBoundaryById(db, plan.boundary.id);
      if (!row) return null;
      if (getCurrentBoundary(db, worktreeId, instanceId)?.id !== row.id) {
        // A newer boundary opened after this send planned (a relaunch inside another
        // send, a reset): the older one is not claimed (consistency review 1).
        this.skipped('superseded', row.id);
        return null;
      }
      if (!sameInstanceLifetime({ incarnation: row.instanceIncarnation, onRoster: row.onRoster }, now, cliToolId)) {
        this.skip(row.id, 'incarnation_changed', 'claim.consume');
        return null;
      }
      rowIncarnation = row.instanceIncarnation;
    }
    if (!sameInstanceLifetime(plan.lifetime, now, cliToolId)) {
      this.skip(rowId, 'incarnation_changed', 'claim.consume');
      return null;
    }

    let body = plan.built.body;
    let includedNoticeIds = plan.built.includedNoticeIds;
    // Issue #4227 (S-B): a claim that attaches nothing reserves no notice.
    if (plan.provider.reserve && plan.skipAs === null) {
      const provider = plan.provider;
      let reserved: { body: string; includedNoticeIds: string[] } | null = null;
      const reserving = this.write('claim.reserve', db, () => {
        try {
          reserved = provider.reserve!({ boundaryId: plan.boundary.id, claimToken: plan.claimToken, includedNoticeIds, body });
        } catch (error) {
          this.warn('session-brief-reserve-failed', error);
        }
      });
      if (reserving !== 'write') {
        this.skipped(reserving, rowId);
        return null;
      }
      this.reserved = { includedNoticeIds };
      // Assigned inside the gate's callback: read back with its declared type.
      const answer = reserved as { body: string; includedNoticeIds: string[] } | null;
      if (!answer || answer.body === '' || !withinVerifiedSize(this.input.typedBody(answer.body + BRIEF_SEPARATOR + this.input.content))) {
        // The notices went to another boundary: this one stays pending for the next send.
        this.skipped('reservation_conflict', rowId);
        return null;
      }
      body = answer.body;
      includedNoticeIds = [...answer.includedNoticeIds];
    }

    let claimedRow = false;
    const claiming = this.write('claim.row', db, () => {
      // pr3f (PM decision 4): the row's incarnation and the claim in one transaction — a claim that
      // throws leaves no filled incarnation (or opened row) behind. A claim that changes no row
      // keeps D1's answer (the body alone).
      claimedRow = db.transaction((): boolean => {
        if (!plan.boundary.existing) {
          openBoundary(db, {
            id: plan.boundary.id,
            worktreeId,
            instanceId,
            cliToolId,
            lifetime: now,
            kind: 'explicit',
            evidence: 'explicit',
            openedAt: plan.boundary.openedAt,
          });
          rowIncarnation = now.incarnation;
        } else if (rowIncarnation === null && now.incarnation !== null) {
          fillBoundaryIncarnation(db, plan.boundary.id, now.incarnation);
          rowIncarnation = now.incarnation;
        }
        return claimBoundary(db, plan.boundary.id, plan.claimToken, rowIncarnation);
      })();
    });
    if (claiming !== 'write') {
      this.skipped(claiming, rowId);
      return null;
    }
    if (!claimedRow) {
      // Another send claimed it between the plan and here (or it went).
      return null;
    }
    liveClaims.add(plan.claimToken);
    this.claimed = { body, includedNoticeIds };
    return body;
  }

  /**
   * Step 3: under the lock, before it is released (design §3.4 5, 2nd review A).
   * `inputStartedAt` is when the body started going in (for a reset's row).
   */
  settleInLock(state: SendAttemptState, inputStartedAt: number): void {
    const db = this.db;
    if (!db) return;
    let outcome = outcomeOf(state);
    if (this.claimed && this.planned?.skipAs && this.settled === null) {
      this.settleUnbriefedInLock(db, this.planned, this.planned.skipAs, outcome);
    } else if (this.claimed && this.planned && this.settled === null) {
      const planned = this.planned;
      const claimed = this.claimed;
      let withheld: BriefWriteWithheld | null = null;
      let putBack = false;
      let held = false;
      try {
        const now = Date.now();
        const delivered = { bytes: bytesOf(claimed.body), mode: planned.built.mode, includedIds: claimed.includedNoticeIds };
        const settling = this.write('settle.claim', db, () => {
          const settled = settleBoundaryClaim(db, planned.boundary.id, planned.claimToken, outcome, delivered, now);
          if (outcome === 'not_sent') putBack = settled;
          if (outcome === 'sent') {
            const copied = copyDeliveryToRelaunchBoundaries(db, this.input.worktreeId, this.input.instanceId, planned.claimToken, delivered, now);
            if (copied > 0 && planned.boundary.kind !== 'launch' && planned.boundary.kind !== 'auto_restart') {
              // D2 design §7.2 R-c (a risk kept): the process this brief reached was started inside
              // the send, but the brief was planned for a conversation step, without the line
              // after an unplanned end. Not briefed again (one brief per conversation).
              logger.info('brief-previous-end-not-delivered', {
                worktreeId: this.input.worktreeId,
                instanceId: this.input.instanceId,
                boundaryId: planned.boundary.id,
                kind: planned.boundary.kind,
              });
            }
          }
        });
        if (settling !== 'write') {
          // D2 design §20: the worktree changed while the body was typed. Nothing is written
          // (the claim, left behind, is settled `unknown` by the next request that is `same`),
          // and the provider is told `unknown` — not an acknowledgement.
          withheld = settling;
          outcome = 'unknown';
        }
      } catch (error) {
        this.warn('session-brief-settle-failed', error);
      } finally {
        // pr3f (PM decision 3): a strict claim not put back stays this process's (the next strict
        // send is 409 `claimed`); D1's goes as before (recovered `unknown` by the next request).
        held = this.strict && outcome === 'not_sent' && !putBack;
        if (!held) liveClaims.delete(planned.claimToken);
        this.settled = outcome;
      }
      this.report = held
        ? { state: 'not_sent', reason: 'claim_held', boundaryId: planned.boundary.id }
        : outcome === 'sent'
          ? { state: 'attached', boundaryId: planned.boundary.id }
          : { state: outcome === 'unknown' ? 'unknown' : 'not_sent', ...(withheld ? { reason: withheld } : {}), boundaryId: planned.boundary.id };
    }
    if (state === 'sent' && this.isReset && this.entryLifetime) {
      // Issue #4224 (W6): not for a worktree made again after the request's entrance. A pinned
      // request needs `same`, as the brief's claim does (Codex 5-2b P2): a pin without evidence
      // (`unknown`: no incarnation, no row at the entrance) cannot tell a worktree made again
      // with the same id and path, whose instance the lifetime check alone would let through.
      // An unpinned send (Timer, relay: never briefed) keeps D1's instance check.
      // Issue #4224 (W6): not for a worktree made again after the request's entrance. A pinned
      // request needs `same`, as the brief's claim does (Codex 5-2b P2): a pin without evidence
      // (`unknown`: no incarnation, no row at the entrance) cannot tell a worktree made again
      // with the same id and path, whose instance the lifetime check alone would let through.
      // An unpinned send (Timer, relay: never briefed) keeps D1's instance check. This is the
      // `reset` guard of D2 design §20 (a withheld write is logged, nothing is opened).
      const lifetime = this.entryLifetime;
      this.write('settle.reset', db, () =>
        openResetBoundaryFromSend(db, {
          worktreeId: this.input.worktreeId,
          cliToolId: this.input.cliToolId,
          instanceId: this.input.instanceId,
          sendId: randomUUID(),
          inputStartedAt,
          lifetime,
        })
      );
    }
  }

  /**
   * Issue #4227 (S-B, design §3.2 "`decline` の予約"): a body that went in (`sent`) or may have
   * (`unknown`) uses the row up as `skipped(declined)`; one that did not (`not_sent`) puts it back
   * to `pending` (`superseded` when a newer row opened) — "don't read" is not used up unsent.
   * pr3f (S-B-commit): `full`'s empty brief the same way, as `skipped(empty)`. When the putting back
   * fails, the claim stays this process's (PM decision 3) and the report says so (`claim_held`).
   */
  private settleUnbriefedInLock(db: Database.Database, planned: Plan, reason: 'declined' | 'empty', state: BoundaryOutcome): void {
    let outcome = state;
    let withheld: BriefWriteWithheld | null = null;
    let putBack = false;
    let held = false;
    try {
      const now = Date.now();
      const settling = this.write('settle.claim', db, () => {
        if (outcome === 'not_sent') putBack = settleBoundaryClaim(db, planned.boundary.id, planned.claimToken, 'not_sent', null, now);
        else settleDeclinedClaim(db, planned.boundary.id, planned.claimToken, now, reason);
      });
      if (settling !== 'write') {
        withheld = settling;
        outcome = 'unknown';
      }
    } catch (error) {
      this.warn('session-brief-settle-failed', error);
    } finally {
      held = outcome === 'not_sent' && !putBack;
      if (!held) liveClaims.delete(planned.claimToken);
      this.settled = outcome;
    }
    const boundaryId = planned.boundary.id;
    this.report = held
      ? { state: 'not_sent', reason: 'claim_held', boundaryId }
      : outcome === 'not_sent'
        ? { state: 'not_sent', boundaryId }
        : withheld
          ? { state: 'unknown', reason: withheld, boundaryId }
          : { state: 'skipped', reason, boundaryId };
  }

  /** The lock's `finally`: a claim that never settled may have been typed (`unknown`). */
  abandonInLock(): void {
    if (this.claimed && this.settled === null) this.settleInLock('indeterminate', Date.now());
  }

  /** Step 4 (design §3.4 6): tell the provider, outside the lock. */
  async afterLock(): Promise<void> {
    const plan = this.planned;
    // Issue #4227: a claim that attaches nothing (`decline`, an empty `full`) reserved nothing; the provider is not told.
    if (!plan || plan.skipAs !== null || !plan.provider.settle) return;
    let outcome: BriefDeliveryOutcome | null = null;
    let includedNoticeIds: string[] = [];
    if (this.claimed && this.settled !== null) {
      outcome = this.settled;
      includedNoticeIds = this.claimed.includedNoticeIds;
    } else if (this.reserved) {
      outcome = 'discarded';
      includedNoticeIds = this.reserved.includedNoticeIds;
    }
    const db = this.db;
    if (outcome === null || !db) return;
    const told = { boundaryId: plan.boundary.id, outcome, includedNoticeIds };
    try {
      let pending: Promise<void> | void = undefined;
      // `settled`: the outcome is what `settle.claim` decided (withheld there: `unknown`).
      this.write('after.provider-settle', db, () => {
        pending = plan.provider.settle!(told);
      });
      await pending;
    } catch (error) {
      this.warn('session-brief-provider-settle-failed', error);
    }
  }

  /** What the route answers in `brief`: attached, a flag's result, or an unknown delivery. */
  reportForResponse(): BriefReport | null {
    if (!this.report) return null;
    // Issue #4227: `full` was a choice, so its result is said (like a flag's); `short` is `auto`.
    if (this.input.mode === 'auto' && this.input.detail !== 'full' && this.report.state === 'skipped') return null;
    return this.report;
  }
}

/** Test hook: forget the claims this process holds (a "restarted" server). */
export function resetLiveBriefClaimsForTest(): void {
  liveClaims.clear();
}
