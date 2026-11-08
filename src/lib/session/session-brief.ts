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
  membershipKey: string;
  provider: BriefProvider;
  built: BriefResult;
  claimToken: string;
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
}

/** One send's brief. Every method fails open: a ledger error costs a log line, never the send. */
export class SendBrief {
  private readonly db: Database.Database | null;
  private readonly supported: boolean;
  private readonly entryLifetime: InstanceLifetime | null;
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
    let lifetime: InstanceLifetime | null = null;
    if (this.supported && this.isReset) {
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

  /** The send's own flag is reported whatever happened; `auto` only when something was attached. */
  private skip(rowId: string | null, reason: BoundarySkipReason | 'no_brief' | 'settings_changed' | 'reservation_conflict', consume: boolean): void {
    if (consume && rowId !== null && this.db) {
      try {
        skipBoundary(this.db, rowId, reason as BoundarySkipReason, Date.now());
      } catch (error) {
        this.warn('session-brief-skip-failed', error);
      }
    }
    this.report = { state: 'skipped', reason, ...(rowId ? { boundaryId: rowId } : {}) };
  }

  /** Whether the delivery must run under the outer input lock (a claim to make, or a reset to record). */
  needsOuterLock(): boolean {
    return this.planned !== null || this.isReset;
  }

  /** Step 1 (design §3.4 1). */
  async plan(): Promise<void> {
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
    let boundary: PlannedBoundary;
    let lifetime: InstanceLifetime;
    try {
      let current = getCurrentBoundary(db, worktreeId, instanceId);
      if (current?.state === 'claimed' && current.claimToken !== null && !liveClaims.has(current.claimToken)) {
        settleStaleClaim(db, current.id, current.claimToken, Date.now());
        current = getBoundaryById(db, current.id);
      }
      const usable =
        current !== null &&
        (current.state === 'pending' || (current.state === 'claimed' && current.claimToken !== null && liveClaims.has(current.claimToken)));
      lifetime = readInstanceLifetime(db, worktreeId, instanceId);
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

    let target: MemTarget;
    try {
      target = await withMemTarget(db, { via: 'worktree', worktreeId }, memTargetDepsOverride ?? {}, (resolved) => resolved);
    } catch (error) {
      this.warn('session-brief-target-failed', error);
      this.skip(rowId, 'target_unresolved', true);
      return;
    }
    if (!target.ok) return this.skip(rowId, 'target_unresolved', true);
    if (target.mode === 'off') return this.skip(rowId, 'off', true);
    if (!target.features.injectOnStart) return this.skip(rowId, 'disabled', true);

    const provider = getBriefProvider();
    const budget = briefBudget(this.input.typedBody, content, provider);
    if (budget.maxBytes < provider.minBytes || budget.maxLines < 1) return this.skip(rowId, 'over_limit', true);

    let built: BriefResult;
    try {
      built = await buildWithTimeout(provider, {
        target: {
          worktreeId,
          cliToolId: cliToolId as Parameters<BriefProvider['build']>[0]['target']['cliToolId'],
          instanceId,
          instanceIncarnation: lifetime.incarnation,
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
      return this.skip(rowId, 'provider_failed', true);
    }
    if (!built || typeof built.body !== 'string' || built.mode !== target.mode || !Array.isArray(built.includedNoticeIds)) {
      return this.skip(rowId, 'provider_failed', true);
    }
    if (built.body === '') return this.skip(rowId, 'empty', true);
    if (bytesOf(built.body) > budget.maxBytes || linesOf(built.body) > budget.maxLines) {
      return this.skip(rowId, 'over_limit', true);
    }
    if (!withinVerifiedSize(this.input.typedBody(built.body + BRIEF_SEPARATOR + content))) {
      return this.skip(rowId, 'over_limit', true);
    }
    this.planned = {
      boundary,
      lifetime,
      membershipKey: membershipKey(target),
      provider,
      built: { body: built.body, includedNoticeIds: [...built.includedNoticeIds], mode: built.mode },
      claimToken: `${PROCESS_NONCE}:${randomUUID()}`,
    };
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
    if (!target.ok || membershipKey(target) !== plan.membershipKey) {
      // Changed while the provider or the lock was waited for: not with the old text.
      if (target.ok && target.mode === 'off') this.skip(rowId, 'off', true);
      else if (target.ok && !target.features.injectOnStart) this.skip(rowId, 'disabled', true);
      this.report = { state: 'skipped', reason: 'settings_changed', ...(rowId ? { boundaryId: rowId } : {}) };
      return null;
    }
    const now = readInstanceLifetime(db, worktreeId, instanceId);
    let rowIncarnation = plan.lifetime.incarnation;
    if (plan.boundary.existing) {
      const row = getBoundaryById(db, plan.boundary.id);
      if (!row) return null;
      if (!sameInstanceLifetime({ incarnation: row.instanceIncarnation, rosterCreatedAt: row.rosterCreatedAt }, now, cliToolId)) {
        this.skip(row.id, 'incarnation_changed', true);
        return null;
      }
      rowIncarnation = row.instanceIncarnation;
    }
    if (!sameInstanceLifetime(plan.lifetime, now, cliToolId)) {
      this.skip(rowId, 'incarnation_changed', true);
      return null;
    }

    let body = plan.built.body;
    let includedNoticeIds = plan.built.includedNoticeIds;
    if (plan.provider.reserve) {
      let answer: { body: string; includedNoticeIds: string[] } | null = null;
      try {
        answer = plan.provider.reserve({ boundaryId: plan.boundary.id, claimToken: plan.claimToken, includedNoticeIds, body });
      } catch (error) {
        this.warn('session-brief-reserve-failed', error);
      }
      this.reserved = { includedNoticeIds };
      if (!answer || answer.body === '' || !withinVerifiedSize(this.input.typedBody(answer.body + BRIEF_SEPARATOR + this.input.content))) {
        // The notices went to another boundary: this one stays pending for the next send.
        this.report = { state: 'skipped', reason: 'reservation_conflict', ...(rowId ? { boundaryId: rowId } : {}) };
        return null;
      }
      body = answer.body;
      includedNoticeIds = [...answer.includedNoticeIds];
    }

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
    if (!claimBoundary(db, plan.boundary.id, plan.claimToken, rowIncarnation)) return null;
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
    const outcome = outcomeOf(state);
    if (this.claimed && this.planned && this.settled === null) {
      try {
        const now = Date.now();
        const delivered = { bytes: bytesOf(this.claimed.body), mode: this.planned.built.mode, includedIds: this.claimed.includedNoticeIds };
        settleBoundaryClaim(db, this.planned.boundary.id, this.planned.claimToken, outcome, delivered, now);
        if (outcome === 'sent') {
          copyDeliveryToRelaunchBoundaries(db, this.input.worktreeId, this.input.instanceId, this.planned.claimToken, delivered, now);
        }
      } catch (error) {
        this.warn('session-brief-settle-failed', error);
      } finally {
        liveClaims.delete(this.planned.claimToken);
        this.settled = outcome;
      }
      this.report =
        outcome === 'sent'
          ? { state: 'attached', boundaryId: this.planned.boundary.id }
          : { state: outcome === 'unknown' ? 'unknown' : 'not_sent', boundaryId: this.planned.boundary.id };
    }
    if (state === 'sent' && this.isReset && this.entryLifetime) {
      openResetBoundaryFromSend(db, {
        worktreeId: this.input.worktreeId,
        cliToolId: this.input.cliToolId,
        instanceId: this.input.instanceId,
        sendId: randomUUID(),
        inputStartedAt,
        lifetime: this.entryLifetime,
      });
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
    if (outcome === null) return;
    try {
      await plan.provider.settle({ boundaryId: plan.boundary.id, outcome, includedNoticeIds });
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
