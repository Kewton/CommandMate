/**
 * The "it ended" notices, as C (#4223), D (#4224) and the screen (#4227) use them
 * (Issue #4222, design §3.3・§3.5). The only way in: C and D call these and nothing
 * under `lib/db/mem-close-db.ts` directly.
 *
 * The contract of C and D (P1-2・2nd review ③):
 * 1. C picks from {@link listMemNoticesFor} (the budget is spent here, each notice's
 *    `uncertain` mark included).
 * 2. D calls {@link reserveMemNotices} with what C picked, marks as read.
 * 3. C rebuilds the notice part from `reserved` only, with its `audience` and `uncertain`.
 * 4. D sends, and calls {@link settleMemNoticeAttempt} with the send result — also
 *    `not-sent` when it stopped before sending.
 *
 * @module lib/mem/notices
 */

import type Database from 'better-sqlite3';
import {
  acknowledgeNoticeByHuman,
  getMemNotice,
  listNoticesFor,
  listUndeliveredNotices,
  noticeAudience,
  presentNotice,
  reserveNotices,
  settleNoticeAttempt,
  type MemHumanAcknowledgement,
  type MemNoticeRecipient,
  type MemNoticeReservation,
  type MemNoticeRow,
  type MemNoticeSelection,
} from '@/lib/db/mem-close-db';
import type { MemNoticeAudience, MemNoticeSendState, MemNoticeView } from '@/types/mem';
import { getInstanceIncarnation, getOrCreateWorktreeIncarnation } from './incarnation';
import { memServerBootId } from './process-boot';
import type { MemTargetResolved } from './target';

export type { MemNoticeRecipient, MemNoticeReservation, MemNoticeSelection };

export interface MemNoticeDeps {
  now?: () => number;
  bootId?: () => string;
}

const clockOf = (deps: MemNoticeDeps) => ({ now: deps.now?.() ?? Date.now(), bootId: deps.bootId?.() ?? memServerBootId() });

/**
 * The recipient as it is when the request arrives: its worktree's lifetime and its
 * instance incarnation are fixed here, and every later write asks them again.
 */
export function captureMemRecipient(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  target: MemTargetResolved
): MemNoticeRecipient {
  return {
    worktreeId,
    instanceId,
    worktreeIncarnation: getOrCreateWorktreeIncarnation(db, worktreeId),
    incarnation: getInstanceIncarnation(db, worktreeId, instanceId)?.incarnation ?? null,
    repositoryIds: target.readRepositoryIds.length > 0 ? target.readRepositoryIds : [target.storageRepositoryId],
    branch: target.detached ? null : target.branch,
  };
}

/** Who this recipient is to the notice (the one judgement, §3.3). Writes nothing. */
export function memNoticeAudience(
  db: Database.Database,
  notice: MemNoticeRow,
  recipient: MemNoticeRecipient
): MemNoticeAudience | null {
  return noticeAudience(db, notice, recipient);
}

/** The notices this recipient may take now. Writes nothing (P2-4). */
export function listMemNoticesFor(db: Database.Database, recipient: MemNoticeRecipient, deps: MemNoticeDeps = {}): MemNoticeView[] {
  return listNoticesFor(db, recipient, clockOf(deps)).map((entry) => presentNotice(db, entry.notice, entry.audience, entry.uncertainCount));
}

export function reserveMemNotices(
  db: Database.Database,
  recipient: MemNoticeRecipient,
  selections: readonly MemNoticeSelection[],
  deps: MemNoticeDeps = {}
): MemNoticeReservation {
  return reserveNotices(db, recipient, selections, clockOf(deps));
}

export function settleMemNoticeAttempt(
  db: Database.Database,
  attemptId: string,
  sendState: MemNoticeSendState,
  deps: MemNoticeDeps = {}
): number {
  return settleNoticeAttempt(db, attemptId, sendState, clockOf(deps).now);
}

export function acknowledgeMemNoticeByHuman(
  db: Database.Database,
  noticeId: string,
  ifVersion: number,
  deps: MemNoticeDeps = {}
): MemHumanAcknowledgement {
  return acknowledgeNoticeByHuman(db, noticeId, ifVersion, clockOf(deps));
}

/** The screen's list of notices nobody has taken (§3.3). Writes nothing. */
export function listUndeliveredMemNotices(
  db: Database.Database,
  repositoryIds: readonly string[],
  branch: string | null | undefined,
  deps: MemNoticeDeps = {}
): MemNoticeView[] {
  return listUndeliveredNotices(db, repositoryIds, branch, clockOf(deps)).map((entry) =>
    presentNotice(db, entry.notice, null, entry.uncertainCount)
  );
}

export { getMemNotice };
