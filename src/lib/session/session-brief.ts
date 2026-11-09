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
  settleStaleClaim,
  skipBoundary,
  type BoundaryOutcome,
  type BoundarySkipReason,
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
import type { SendAttemptState } from '@/lib/session/send-attempt-types';
import { createLogger } from '@/lib/logger';

const logger = createLogger('session/session-brief');

/** What a send asks of the brief (design §4.1). The service's default is `never`. */
export type BriefSendMode = 'auto' | 'skip' | 'force' | 'never';

/** Between the brief and the operator's body (D12: the brief's own framing is C's). */
export const BRIEF_SEPARATOR = '\n\n';

/** How long a provider may take before the body is sent without it (design §5.1, U7). */
export const BRIEF_PROVIDER_TIMEOUT_MS = 2_000;

/** What a send says about its brief (the route's `brief` field). */
export interface BriefReport {
  state: 'attached' | 'skipped' | 'unknown' | 'not_sent';
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
/** Claims a send of this process holds right now. */
const liveClaims = new Set<string>();

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
  provider: Pick<BriefProvider, 'defaultBytes'>
): { maxBytes: number; maxLines: number } {
  const base = typedBody(BRIEF_SEPARATOR + content);
  return {
    maxBytes: Math.min(provider.defaultBytes, SEND_VERIFIED_MAX_BYTES - bytesOf(base)),
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
}

/** One send's brief. Every method fails open: a ledger error costs a log line, never the send. */
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
   * The one gate every write of a send goes through (D2 design §20): the site's guard from
   * {@link BRIEF_WRITE_RULES}, read in the caller's synchronous stretch. Withheld: nothing is
   * written, and the reason is answered for the caller to report (fail-closed).
   */
  private write(site: BriefWriteSite, db: Database.Database, write: () => void): BriefWriteWithheld | 'write' {
    const verdict = briefWriteVerdict(BRIEF_WRITE_RULES[site], this.pin !== null, this.continuity(db), () => this.instanceAsPinned(db));
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

  /** Whether the delivery must run under the outer input lock (a claim to make, or a reset to record). */
  needsOuterLock(): boolean {
    return this.planned !== null || this.isReset;
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
    this.report = { state: 'skipped', reason: 'worktree_changed', ...(rowId ? { boundaryId: rowId } : {}) };
  }

  /** Step 1 (design §3.4 1). A second call does nothing (D2 design §3.3 (c)). */
  async plan(): Promise<void> {
    if (this.planCalled) return;
    this.planCalled = true;
    const { mode, content, worktreeId, instanceId, cliToolId } = this.input;
    if (mode === 'never') return;
    if (!this.supported || !this.db) {
      if (mode !== 'auto') this.report = { state: 'skipped', reason: 'unsupported' };
      return;
    }
    // A command with words in front of it is no command (a reset still opens its row, step 3).
    if (isSlashCommandBody(content)) {
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
      this.report = { state: 'skipped', reason: 'lifetime_unpinned' };
      return;
    }
    let boundary: PlannedBoundary;
    let lifetime: InstanceLifetime;
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
        this.report = { state: 'skipped', reason: 'incarnation_changed', boundaryId: current.id };
        return;
      }
      if (current?.state === 'claimed' && current.claimToken !== null && !liveClaims.has(current.claimToken)) {
        const stale = current;
        const settled = this.write('plan.stale-claim', db, () => settleStaleClaim(db, stale.id, stale.claimToken!, Date.now()));
        if (settled !== 'write') {
          // D2 design §20: a pin without evidence (`unknown`) settles nothing either.
          this.report = { state: 'skipped', reason: settled, boundaryId: stale.id };
          return;
        }
        current = getBoundaryById(db, current.id);
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
      if (usable && current) {
        boundary = { id: current.id, kind: current.kind, late: current.late, openedAt: current.openedAt, existing: true };
      } else if (mode === 'force') {
        boundary = { id: randomUUID(), kind: 'explicit', late: false, openedAt: Date.now(), existing: false };
      } else {
        return;
      }
    } catch (error) {
      this.warn('session-brief-plan-read-failed', error);
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

    const provider = getBriefProvider();
    const budget = briefBudget(this.input.typedBody, content, provider);
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
    if (built.body === '') return this.skip(rowId, 'empty', 'plan.consume');
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
      this.report = { state: 'skipped', reason: made === 'write' ? 'lifetime_unpinned' : made, ...(rowId ? { boundaryId: rowId } : {}) };
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
    const plan = this.planned;
    const db = this.db;
    if (!plan || !db) return this.input.content;
    try {
      const body = await withMemTarget(db, { via: 'worktree', worktreeId: this.input.worktreeId }, memTargetDepsOverride ?? {}, (target) =>
        this.claimInStretch(db, plan, target)
      );
      if (body === null) return this.input.content;
      return body + BRIEF_SEPARATOR + this.input.content;
    } catch (error) {
      this.warn('session-brief-claim-failed', error);
      return this.input.content;
    }
  }

  /** The synchronous stretch `withMemTarget` settled the membership in. Returns the brief, or null. */
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
      this.report = { state: 'skipped', reason: 'settings_changed', ...(rowId ? { boundaryId: rowId } : {}) };
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
        this.report = { state: 'skipped', reason: 'superseded', boundaryId: row.id };
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
    if (plan.provider.reserve) {
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
        this.report = { state: 'skipped', reason: reserving, ...(rowId ? { boundaryId: rowId } : {}) };
        return null;
      }
      this.reserved = { includedNoticeIds };
      // Assigned inside the gate's callback: read back with its declared type.
      const answer = reserved as { body: string; includedNoticeIds: string[] } | null;
      if (!answer || answer.body === '' || !withinVerifiedSize(this.input.typedBody(answer.body + BRIEF_SEPARATOR + this.input.content))) {
        // The notices went to another boundary: this one stays pending for the next send.
        this.report = { state: 'skipped', reason: 'reservation_conflict', ...(rowId ? { boundaryId: rowId } : {}) };
        return null;
      }
      body = answer.body;
      includedNoticeIds = [...answer.includedNoticeIds];
    }

    let claimedRow = false;
    const claiming = this.write('claim.row', db, () => {
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
      claimedRow = claimBoundary(db, plan.boundary.id, plan.claimToken, rowIncarnation);
    });
    if (claiming !== 'write') {
      this.report = { state: 'skipped', reason: claiming, ...(rowId ? { boundaryId: rowId } : {}) };
      return null;
    }
    if (!claimedRow) return null;
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
    if (this.claimed && this.planned && this.settled === null) {
      const planned = this.planned;
      const claimed = this.claimed;
      let withheld: BriefWriteWithheld | null = null;
      try {
        const now = Date.now();
        const delivered = { bytes: bytesOf(claimed.body), mode: planned.built.mode, includedIds: claimed.includedNoticeIds };
        const settling = this.write('settle.claim', db, () => {
          settleBoundaryClaim(db, planned.boundary.id, planned.claimToken, outcome, delivered, now);
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
        liveClaims.delete(planned.claimToken);
        this.settled = outcome;
      }
      this.report =
        outcome === 'sent'
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

  /** The lock's `finally`: a claim that never settled may have been typed (`unknown`). */
  abandonInLock(): void {
    if (this.claimed && this.settled === null) this.settleInLock('indeterminate', Date.now());
  }

  /** Step 4 (design §3.4 6): tell the provider, outside the lock. */
  async afterLock(): Promise<void> {
    const plan = this.planned;
    if (!plan || !plan.provider.settle) return;
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
    if (this.input.mode === 'auto' && this.report.state === 'skipped') return null;
    return this.report;
  }
}

/** Test hook: forget the claims this process holds (a "restarted" server). */
export function resetLiveBriefClaimsForTest(): void {
  liveClaims.clear();
}
