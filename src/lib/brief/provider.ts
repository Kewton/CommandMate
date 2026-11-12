/**
 * C's implementation of D1's {@link BriefProvider} port (Issue #4223, design §5).
 *
 * D2 (#4224, design `docs/design/brief-injection-d2-4224.md` §4・§5) connects it:
 * `getBriefProvider()` answers {@link MEM_BRIEF_PORT}, which is {@link MEM_BRIEF_PROVIDER}
 * with D1's `settle` connected to {@link settleBriefAttempt} (#4222's receipt). `build`
 * builds for the lifetimes the send's entrance fixed (`request.target`, D2 §2.4 W2) and
 * never fixes its own.
 *
 * Two tables in this process's memory (design §5.3):
 *  - `memos`: what each build drew, per boundary. Bounded; a dropped one only makes
 *    its `reserve` answer null (the boundary stays pending for the next send).
 *  - `attempts`: the reservation a claim made, at most one open per boundary, never
 *    dropped for count. It keeps the ids `reserve` was handed (what D1 returns with
 *    `discarded`) apart from the ids reserved (what it returns once claimed), and the
 *    number of `reserve` calls it refused, which settle as `discarded` first.
 *
 * @module lib/brief/provider
 */

import type Database from 'better-sqlite3';
import { getDbInstance } from '@/lib/db/db-instance';
import { createLogger } from '@/lib/logger';
import {
  reserveMemNotices,
  settleMemNoticeAttempt,
  type MemNoticeDeps,
  type MemNoticeRecipient,
  type MemNoticeSelection,
} from '@/lib/mem/notices';
import type { BriefDeliveryOutcome, BriefProvider, BriefRequest, BriefResult } from '@/lib/session/brief-provider';
import type { MemNoticeSendState } from '@/types/mem';
import { BRIEF_BUDGET } from '@/types/brief';
import { buildBrief, PROVIDER_TIME_BUDGET, type BriefBuildDeps } from './build';
import { fitText } from './fit';
import { entryLine } from './render';

const logger = createLogger('brief/provider');

/** Memos kept across every boundary (design §5.3). */
export const BRIEF_MEMO_LIMIT = 64;
/** #4222's stale attempt (B §3.5): after this an open attempt is forgotten here too. */
export const BRIEF_ATTEMPT_STALE_MS = 10 * 60 * 1000;

interface Memo {
  boundaryId: string;
  body: string;
  recipient: MemNoticeRecipient | null;
  selections: MemNoticeSelection[];
  /** The line of each notice in `body`, to take out the ones not reserved. */
  noticeLines: Map<string, string>;
  membershipKey: string;
}

interface AttemptRow {
  attempt: { attemptId: string; requestedIds: string[]; noticeIds: string[]; createdAt: number } | null;
  declined: number;
}

/**
 * The body without the lines of the notices that were not reserved, and with the omitted
 * count of its 4th line raised by as many (review P3-3, 2026-11-09): the count says how
 * many entries the reader does not see, and a dropped notice is one. Shorter than the
 * body it came from (a line goes, at most a digit comes), so still within the budget.
 */
export function dropNoticeLines(body: string, drop: ReadonlySet<string>): string {
  if (drop.size === 0) return body;
  const lines = body.split('\n');
  const kept = lines.filter((line, index) => index < 4 || !drop.has(line));
  const dropped = lines.length - kept.length;
  kept[3] = kept[3].replace(/^omitted=(\d+)/, (_match, count: string) => `omitted=${Number(count) + dropped}`);
  return kept.join('\n');
}

export interface MemBriefProviderDeps extends BriefBuildDeps {
  notices?: MemNoticeDeps;
}

export interface MemBriefProviderState {
  provider: BriefProvider;
  settle(delivery: { boundaryId: string; outcome: BriefDeliveryOutcome; includedNoticeIds: string[] }): void;
  /** Test hooks. */
  memoCount(): number;
  attemptOf(boundaryId: string): Readonly<AttemptRow> | undefined;
  reset(): void;
}

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  if (a.length !== b.length) return false;
  const set = new Set(a);
  return b.every((id) => set.has(id));
};

const SEND_STATE: Readonly<Record<BriefDeliveryOutcome, MemNoticeSendState>> = {
  sent: 'sent',
  not_sent: 'not-sent',
  discarded: 'not-sent',
  unknown: 'indeterminate',
};

export function createMemBriefProvider(getDb: () => Database.Database, deps: MemBriefProviderDeps = {}): MemBriefProviderState {
  const memos: Memo[] = [];
  const attempts = new Map<string, AttemptRow>();
  const now = (): number => (deps.now ?? Date.now)();

  const sweep = (): void => {
    for (const [boundaryId, row] of attempts) {
      if (row.attempt && now() - row.attempt.createdAt >= BRIEF_ATTEMPT_STALE_MS) row.attempt = null;
      if (!row.attempt && row.declined === 0) attempts.delete(boundaryId);
    }
  };

  const rowOf = (boundaryId: string): AttemptRow => {
    let row = attempts.get(boundaryId);
    if (!row) {
      row = { attempt: null, declined: 0 };
      attempts.set(boundaryId, row);
    }
    return row;
  };

  async function build(request: BriefRequest): Promise<BriefResult> {
    const db = getDb();
    const outcome = await buildBrief(
      db,
      {
        worktreeId: request.target.worktreeId,
        instanceId: request.target.instanceId,
        time: PROVIDER_TIME_BUDGET,
        request,
        maxLines: request.budget.maxLines,
        // Issue #4224 (D2 design §2.4 W2): the lifetimes the send's entrance fixed.
        pinned: {
          worktreeIncarnation: request.target.worktreeIncarnation,
          instance: {
            incarnation: request.target.instanceIncarnation,
            onRoster: request.target.instanceOnRoster,
            incarnationToolId: null,
            incarnationIssuedBy: null,
          },
        },
        onMembershipTimeout: 'throw',
      },
      deps
    );
    if (outcome.kind !== 'built') return { body: '', includedNoticeIds: [], mode: request.membership.mode };
    const fitted = fitText(outcome.model, {
      maxBytes: request.budget.maxBytes,
      trailingNewline: false,
      maxLines: request.budget.maxLines,
      // Issue #4227 (S-F): only `full` lifts the per-entry cap; absent / `short` are as before.
      ...(request.detail === 'full' ? { itemCap: false } : {}),
    });
    if (fitted.leadUnfit) {
      // D2 design §7.4: the line after an unplanned end is required; without it, no brief.
      return { body: '', includedNoticeIds: [], mode: outcome.model.fixed.mode, skipReason: 'over_limit' };
    }
    const notices = fitted.included.filter((item) => item.notice);
    memos.push({
      boundaryId: request.boundary.id,
      body: fitted.text,
      recipient: outcome.recipient,
      selections: notices.map((item) => ({ noticeId: item.notice!.id, uncertain: item.notice!.uncertain })),
      noticeLines: new Map(notices.map((item) => [item.notice!.id, entryLine(item.entry)])),
      membershipKey: outcome.membershipKey,
    });
    while (memos.length > BRIEF_MEMO_LIMIT) memos.shift();
    return { body: fitted.text, includedNoticeIds: notices.map((item) => item.notice!.id), mode: outcome.model.fixed.mode };
  }

  function reserve(claim: { boundaryId: string; claimToken: string; includedNoticeIds: string[]; body: string }) {
    sweep();
    const memo = [...memos].reverse().find((entry) => entry.boundaryId === claim.boundaryId && entry.body === claim.body);
    // No notice: nothing to reserve, nothing D1 will settle (2nd review ③).
    if (claim.includedNoticeIds.length === 0) return memo ? { body: claim.body, includedNoticeIds: [] } : null;
    const row = rowOf(claim.boundaryId);
    if (!memo || !memo.recipient || row.attempt) {
      row.declined += 1;
      return null;
    }
    const wanted = new Set(claim.includedNoticeIds);
    const selections = memo.selections.filter((selection) => wanted.has(selection.noticeId));
    let reserved;
    try {
      reserved = reserveMemNotices(getDb(), memo.recipient, selections, deps.notices);
    } catch (error) {
      logger.warn('brief-reserve-failed', { boundaryId: claim.boundaryId, error: error instanceof Error ? error.message : String(error) });
      row.declined += 1;
      return null;
    }
    if (reserved.attemptId === null) {
      row.declined += 1;
      return null;
    }
    const noticeIds = reserved.reserved.map((entry) => entry.noticeId);
    row.attempt = { attemptId: reserved.attemptId, requestedIds: [...claim.includedNoticeIds], noticeIds, createdAt: now() };
    const kept = new Set(noticeIds);
    const drop = new Set([...memo.noticeLines].filter(([id]) => !kept.has(id)).map(([, line]) => line));
    return { body: dropNoticeLines(claim.body, drop), includedNoticeIds: noticeIds };
  }

  function settle(delivery: { boundaryId: string; outcome: BriefDeliveryOutcome; includedNoticeIds: string[] }): void {
    sweep();
    if (delivery.includedNoticeIds.length === 0) return;
    const row = attempts.get(delivery.boundaryId);
    const attempt = row?.attempt ?? null;
    if (delivery.outcome === 'discarded' && row && row.declined > 0) {
      row.declined -= 1;
    } else if (attempt && sameSet(delivery.outcome === 'discarded' ? attempt.requestedIds : attempt.noticeIds, delivery.includedNoticeIds)) {
      settleMemNoticeAttempt(getDb(), attempt.attemptId, SEND_STATE[delivery.outcome], deps.notices);
      row!.attempt = null;
    } else {
      logger.info('brief-settle-unmatched', { boundaryId: delivery.boundaryId, outcome: delivery.outcome });
    }
    if (row && !row.attempt && row.declined === 0) attempts.delete(delivery.boundaryId);
  }

  const provider: BriefProvider = {
    id: 'mem-brief',
    minBytes: BRIEF_BUDGET.text.min,
    defaultBytes: BRIEF_BUDGET.text.default,
    build,
    reserve,
  };
  return {
    provider,
    settle,
    memoCount: () => memos.length,
    attemptOf: (boundaryId) => attempts.get(boundaryId),
    reset: () => {
      memos.length = 0;
      attempts.clear();
    },
  };
}

const DEFAULT_STATE = createMemBriefProvider(() => getDbInstance());

/** C's provider (D2 hands it to `getBriefProvider()`; C does not). */
export const MEM_BRIEF_PROVIDER: BriefProvider = DEFAULT_STATE.provider;

/** What D2 connects D1's `settle` to: #4222's receipt for the attempt the claim made (design §5.1). */
export function settleBriefAttempt(delivery: { boundaryId: string; outcome: BriefDeliveryOutcome; includedNoticeIds: string[] }): void {
  DEFAULT_STATE.settle(delivery);
}

/**
 * The provider sends are briefed by (Issue #4224, D2 design §4.1): C's, with D1's `settle`
 * connected to #4222's receipt. {@link MEM_BRIEF_PROVIDER} itself keeps no `settle`.
 */
export const MEM_BRIEF_PORT: BriefProvider = { ...MEM_BRIEF_PROVIDER, settle: settleBriefAttempt };

/** Test hook: forget the memos and attempts of {@link MEM_BRIEF_PORT} (a "restarted" server). */
export function resetMemBriefPortForTest(): void {
  DEFAULT_STATE.reset();
}
