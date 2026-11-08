/**
 * What a condition's close leaves behind, and the delivery of its notice (Issue #4222,
 * design `docs/design/mem-close-when-4222.md` §3).
 *
 * Synchronous, each write one transaction. Every write asks again, inside its
 * transaction, the things an await could have changed: the mode of the item's branch
 * (§4), the version the evaluation read (§3.2・§5) and the lifetime of the worktree
 * the request was read for (the invariant of `tests/unit/lib/mem/close-entrances-4222.test.ts`).
 *
 * Who receives a notice is decided by one function, {@link noticeAudience}; the list,
 * the reservation and the screen all call it (P1-3).
 *
 * @module lib/db/mem-close-db
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { closeMemItemByCondition, decideRootMode } from '@/lib/db/mem-db';
import { resolveWorktreeIdWithAlias } from '@/lib/db/worktree-alias-db';
import {
  getInstanceIncarnation,
  getInstanceIncarnationRow,
  getWorktreeIncarnation,
  instanceIncarnationAlive,
  worktreeIncarnationAlive,
} from '@/lib/mem/incarnation';
import type {
  MemCloseWhenType,
  MemEndOutcome,
  MemEvalTrigger,
  MemNoticeAudience,
  MemNoticeSendState,
  MemNoticeView,
} from '@/types/mem';

/** A reservation older than this, in the same process, is stale (§3.5). */
export const MEM_NOTICE_ATTEMPT_STALE_MS = 10 * 60 * 1000;
/** Acknowledged notices and settled attempts are kept this long (§3.5, A §8.3). */
export const MEM_NOTICE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** The session asking for its notices, fixed when the request arrived. */
export interface MemNoticeRecipient {
  worktreeId: string;
  instanceId: string;
  /** The worktree's lifetime when the request was read. */
  worktreeIncarnation: string;
  /** The instance's incarnation when the request was read; null when it had none. */
  incarnation: string | null;
  /** Every root that reads as the recipient's repository, and its branch (null: detached). */
  repositoryIds: string[];
  branch: string | null;
}

export interface MemNoticeRow {
  id: string;
  item_id: string;
  repository_id: string;
  branch: string | null;
  origin_worktree_ref: string;
  origin_worktree_incarnation: string;
  origin_instance_id: string;
  origin_cli_tool_id: string;
  origin_incarnation: string;
  item_created_at: number;
  state: 'pending' | 'reserved' | 'acknowledged';
  attempt_id: string | null;
  attempt_audience: MemNoticeAudience | null;
  uncertain_count: number;
  acknowledged_at: number | null;
  acknowledged_by: 'creator' | 'successor' | 'human' | null;
  acknowledged_instance_id: string | null;
  acknowledged_incarnation: string | null;
  version: number;
  created_at: number;
}

interface AttemptRow {
  id: string;
  boot_id: string;
  recipient_worktree_ref: string;
  recipient_worktree_incarnation: string;
  recipient_instance_id: string;
  recipient_incarnation: string | null;
  created_at: number;
  settled_at: number | null;
  result: string | null;
}

export interface MemNoticeClock {
  bootId: string;
  now: number;
}

// ---------------------------------------------------------------------------
// The common rules (§3.3・§4)
// ---------------------------------------------------------------------------

/** Whether mem is `on` for this branch at every one of these roots, read from the database now (§4). */
export function memModeOnFor(db: Database.Database, repositoryIds: readonly string[], branch: string | null): boolean {
  if (repositoryIds.length === 0) return false;
  return repositoryIds.every((id) => decideRootMode(db, id, branch).mode === 'on');
}

/** Whether the recipient is still the session the request was read for. */
export function recipientStillHere(db: Database.Database, recipient: MemNoticeRecipient): boolean {
  if (getWorktreeIncarnation(db, recipient.worktreeId) !== recipient.worktreeIncarnation) return false;
  return (getInstanceIncarnation(db, recipient.worktreeId, recipient.instanceId)?.incarnation ?? null) === recipient.incarnation;
}

function sameBranch(db: Database.Database, notice: MemNoticeRow, recipient: MemNoticeRecipient): boolean {
  if (!recipient.repositoryIds.includes(notice.repository_id)) return false;
  if (notice.branch === null) {
    // Detached: the branch is the worktree it was written in.
    return recipient.branch === null && resolveWorktreeIdWithAlias(db, notice.origin_worktree_ref) === recipient.worktreeId;
  }
  return recipient.branch === notice.branch;
}

/**
 * Who the recipient is to this notice (§3.3), or null when it may not take it.
 *
 * - `creator`: its incarnation is the author's (the worktree id is not compared: a
 *   rename keeps the author).
 * - `successor`, once the author's incarnation is gone: (a) the same slot (instance
 *   id, the author's worktree after renames, same branch) whatever its incarnation;
 *   (b) another session of the same branch whose incarnation a roster issued after the
 *   item was written (`issued_by = 'roster'`, S6・2nd review ①).
 *
 * Writes nothing.
 */
export function noticeAudience(
  db: Database.Database,
  notice: MemNoticeRow,
  recipient: Pick<MemNoticeRecipient, 'worktreeId' | 'instanceId' | 'repositoryIds' | 'branch'>
): MemNoticeAudience | null {
  const own = getInstanceIncarnationRow(db, recipient.worktreeId, recipient.instanceId);
  if (own && own.incarnation === notice.origin_incarnation) return 'creator';
  if (instanceIncarnationAlive(db, notice.origin_incarnation)) return null;
  const full = { worktreeIncarnation: '', incarnation: null, ...recipient };
  if (!sameBranch(db, notice, full)) return null;
  if (
    recipient.instanceId === notice.origin_instance_id &&
    resolveWorktreeIdWithAlias(db, notice.origin_worktree_ref) === recipient.worktreeId
  ) {
    return 'successor';
  }
  if (own && own.issuedBy === 'roster' && own.createdAt > notice.item_created_at) return 'successor';
  return null;
}

function attemptOf(db: Database.Database, id: string | null): AttemptRow | undefined {
  if (!id) return undefined;
  return db.prepare('SELECT * FROM mem_notice_attempts WHERE id = ?').get(id) as AttemptRow | undefined;
}

/** A reservation of another boot, or older than {@link MEM_NOTICE_ATTEMPT_STALE_MS} (§3.5). */
export function attemptIsStale(attempt: Pick<AttemptRow, 'boot_id' | 'created_at'>, clock: MemNoticeClock): boolean {
  return attempt.boot_id !== clock.bootId || clock.now - attempt.created_at > MEM_NOTICE_ATTEMPT_STALE_MS;
}

/** A notice as a reader sees it now: a stale reservation reads as pending, its +1 counted in (2nd review ③). */
function readable(db: Database.Database, notice: MemNoticeRow, clock: MemNoticeClock): { open: boolean; uncertainCount: number } {
  if (notice.state === 'pending') return { open: true, uncertainCount: notice.uncertain_count };
  if (notice.state === 'reserved') {
    const attempt = attemptOf(db, notice.attempt_id);
    if (!attempt || attemptIsStale(attempt, clock)) return { open: true, uncertainCount: notice.uncertain_count + 1 };
  }
  return { open: false, uncertainCount: notice.uncertain_count };
}

interface CloseRecordRow {
  end_reason: string;
  outcome: MemEndOutcome;
  closed_at: number;
}

function closeRecordOf(db: Database.Database, itemId: string): CloseRecordRow | undefined {
  return db.prepare('SELECT end_reason, outcome, closed_at FROM mem_close_records WHERE item_id = ?').get(itemId) as
    | CloseRecordRow
    | undefined;
}

const iso = (epoch: number) => new Date(epoch).toISOString();

export function presentNotice(
  db: Database.Database,
  notice: MemNoticeRow,
  audience: MemNoticeAudience | null,
  uncertainCount: number
): MemNoticeView {
  const record = closeRecordOf(db, notice.item_id);
  return {
    id: notice.id,
    itemId: notice.item_id,
    repositoryId: notice.repository_id,
    branch: notice.branch,
    origin: {
      worktreeId: notice.origin_worktree_ref,
      instanceId: notice.origin_instance_id,
      cliToolId: notice.origin_cli_tool_id,
      incarnation: notice.origin_incarnation,
      itemCreatedAt: iso(notice.item_created_at),
    },
    state: notice.state,
    audience,
    uncertain: uncertainCount > 0,
    uncertainCount,
    endReason: record?.end_reason ?? 'unknown',
    outcome: record?.outcome ?? 'unknown',
    closedAt: iso(record?.closed_at ?? notice.created_at),
    version: notice.version,
    acknowledgedBy: notice.acknowledged_by,
  };
}

// ---------------------------------------------------------------------------
// Reads (write nothing, §3.3 P2-4)
// ---------------------------------------------------------------------------

export function getMemNotice(db: Database.Database, id: string): MemNoticeRow | null {
  return (db.prepare('SELECT * FROM mem_notices WHERE id = ?').get(id) as MemNoticeRow | undefined) ?? null;
}

/** The notices this recipient may take now, oldest first. Writes nothing. */
export function listNoticesFor(
  db: Database.Database,
  recipient: MemNoticeRecipient,
  clock: MemNoticeClock
): Array<{ notice: MemNoticeRow; audience: MemNoticeAudience; uncertainCount: number }> {
  const marks = recipient.repositoryIds.map(() => '?').join(',') || "''";
  const rows = db
    .prepare(
      `SELECT * FROM mem_notices WHERE state != 'acknowledged'
         AND (origin_incarnation = ? OR (repository_id IN (${marks}) AND branch IS ?))
       ORDER BY item_created_at, rowid`
    )
    .all(recipient.incarnation ?? '', ...recipient.repositoryIds, recipient.branch) as MemNoticeRow[];
  const out: Array<{ notice: MemNoticeRow; audience: MemNoticeAudience; uncertainCount: number }> = [];
  for (const notice of rows) {
    const seen = readable(db, notice, clock);
    if (!seen.open) continue;
    const audience = noticeAudience(db, notice, recipient);
    if (audience) out.push({ notice, audience, uncertainCount: seen.uncertainCount });
  }
  return out;
}

/** The notices of a branch that nobody has taken (the screen, §3.3). Writes nothing. */
export function listUndeliveredNotices(
  db: Database.Database,
  repositoryIds: readonly string[],
  branch: string | null | undefined,
  clock: MemNoticeClock
): Array<{ notice: MemNoticeRow; uncertainCount: number }> {
  if (repositoryIds.length === 0) return [];
  const marks = repositoryIds.map(() => '?').join(',');
  const rows = (
    branch === undefined
      ? db
          .prepare(`SELECT * FROM mem_notices WHERE state != 'acknowledged' AND repository_id IN (${marks}) ORDER BY item_created_at, rowid`)
          .all(...repositoryIds)
      : db
          .prepare(
            `SELECT * FROM mem_notices WHERE state != 'acknowledged' AND repository_id IN (${marks}) AND branch IS ? ORDER BY item_created_at, rowid`
          )
          .all(...repositoryIds, branch)
  ) as MemNoticeRow[];
  return rows.map((notice) => ({ notice, uncertainCount: readable(db, notice, clock).uncertainCount }));
}

/** `execution_logs.status` of a schedule run, or null (§1.6 `schedule:`). Read only. */
export function readScheduleRunStatus(db: Database.Database, executionLogId: string): string | null {
  const row = db.prepare('SELECT status FROM execution_logs WHERE id = ?').get(executionLogId) as { status: string } | undefined;
  return row ? row.status : null;
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

function pruneRetention(db: Database.Database, now: number): void {
  const before = now - MEM_NOTICE_RETENTION_MS;
  db.prepare("DELETE FROM mem_notices WHERE state = 'acknowledged' AND acknowledged_at < ?").run(before);
  db.prepare(
    `DELETE FROM mem_notice_attempts WHERE settled_at IS NOT NULL AND settled_at < ?
       AND id NOT IN (SELECT attempt_id FROM mem_notices WHERE attempt_id IS NOT NULL)`
  ).run(before);
}

export interface MemConditionClose {
  item: { id: string; version: number; closeWhen: string; type: MemCloseWhenType; repositoryId: string; branch: string | null };
  answer: { endReason: string; outcome: MemEndOutcome; observation: unknown };
  trigger: MemEvalTrigger;
  triggeredBy: { worktreeId: string; instanceId: string | null } | null;
  /** The roots of the target the evaluation was for: the mode must be `on` at each (§3.2・§4). */
  modeRoots: readonly string[];
  /** Whether the worktree the request was read for is still the same lifetime; null via a repository. */
  alive: (() => boolean) | null;
  now: number;
}

/**
 * Close one item by its condition, with its end record and its notice, in one
 * transaction (§3.2). false when anything the evaluation read changed: the mode, the
 * version or the condition, the state (a decision before promotion), or the worktree.
 */
export function closeItemByCondition(db: Database.Database, input: MemConditionClose): boolean {
  return db.transaction((): boolean => {
    if (input.alive && !input.alive()) return false;
    const roots = [...new Set([input.item.repositoryId, ...input.modeRoots])];
    if (!memModeOnFor(db, roots, input.item.branch)) return false;
    const closed = closeMemItemByCondition(
      db,
      input.item.id,
      { version: input.item.version, closeWhen: input.item.closeWhen },
      input.now
    );
    if (!closed) return false;
    db.prepare(
      `INSERT INTO mem_close_records (item_id, condition_json, condition_type, evaluated_version, observation_json, end_reason,
         outcome, trigger, triggered_by_worktree_ref, triggered_by_instance_id, closed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.item.id,
      input.item.closeWhen,
      input.item.type,
      input.item.version,
      JSON.stringify(input.answer.observation),
      input.answer.endReason,
      input.answer.outcome,
      input.trigger,
      input.triggeredBy?.worktreeId ?? null,
      input.triggeredBy?.instanceId ?? null,
      input.now
    );
    db.prepare(
      `INSERT INTO mem_notices (id, item_id, repository_id, branch, origin_worktree_ref, origin_worktree_incarnation,
         origin_instance_id, origin_cli_tool_id, origin_incarnation, item_created_at, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
       ON CONFLICT(item_id) DO NOTHING`
    ).run(
      randomUUID(),
      closed.id,
      closed.owner.repositoryId,
      closed.owner.branch,
      closed.owner.worktreeId,
      closed.owner.worktreeIncarnation,
      closed.owner.instanceId,
      closed.owner.cliToolId,
      closed.owner.incarnation,
      closed.createdAt,
      input.now
    );
    pruneRetention(db, input.now);
    return true;
  })();
}

/** Put back every stale reservation: the attempt is abandoned, its notices pending with +1 (§3.5). */
function abandonStaleAttempts(db: Database.Database, clock: MemNoticeClock): void {
  const open = db.prepare('SELECT * FROM mem_notice_attempts WHERE settled_at IS NULL').all() as AttemptRow[];
  for (const attempt of open) {
    if (attemptIsStale(attempt, clock)) abandonAttempt(db, attempt.id, clock.now);
  }
}

function abandonAttempt(db: Database.Database, attemptId: string, now: number): void {
  db.prepare(
    `UPDATE mem_notices SET state = 'pending', attempt_id = NULL, attempt_audience = NULL,
       uncertain_count = uncertain_count + 1, version = version + 1 WHERE attempt_id = ?`
  ).run(attemptId);
  db.prepare("UPDATE mem_notice_attempts SET settled_at = ?, result = 'abandoned' WHERE id = ?").run(now, attemptId);
}

/** Put back the stale (or lost) reservation holding this notice, as {@link abandonStaleAttempts} would. */
function abandonAttemptOf(db: Database.Database, notice: MemNoticeRow, clock: MemNoticeClock): void {
  const attempt = attemptOf(db, notice.attempt_id);
  if (attempt) {
    abandonAttempt(db, attempt.id, clock.now);
    return;
  }
  db.prepare(
    `UPDATE mem_notices SET state = 'pending', attempt_id = NULL, attempt_audience = NULL,
       uncertain_count = uncertain_count + 1, version = version + 1 WHERE id = ?`
  ).run(notice.id);
}

export interface MemNoticeSelection {
  noticeId: string;
  /** The "previous delivery not confirmed" mark C read and budgeted for (2nd review ③). */
  uncertain: boolean;
}

export interface MemNoticeReservation {
  attemptId: string | null;
  reserved: Array<{ noticeId: string; audience: MemNoticeAudience; uncertain: boolean }>;
}

/**
 * Reserve the chosen notices for one brief (§3.5, P1-2). Only those still pending,
 * that this recipient may take, whose mode is `on`, and whose mark is the one C
 * budgeted for. No attempt is made when none is.
 */
export function reserveNotices(
  db: Database.Database,
  recipient: MemNoticeRecipient,
  selections: readonly MemNoticeSelection[],
  clock: MemNoticeClock
): MemNoticeReservation {
  return db.transaction((): MemNoticeReservation => {
    const none: MemNoticeReservation = { attemptId: null, reserved: [] };
    if (!recipientStillHere(db, recipient)) return none;
    if (!memModeOnFor(db, recipient.repositoryIds, recipient.branch)) return none;
    abandonStaleAttempts(db, clock);
    const taken: MemNoticeReservation['reserved'] = [];
    const seen = new Set<string>();
    for (const selection of selections) {
      if (seen.has(selection.noticeId)) continue;
      seen.add(selection.noticeId);
      const notice = getMemNotice(db, selection.noticeId);
      if (!notice || notice.state !== 'pending') continue;
      if (!memModeOnFor(db, [notice.repository_id], notice.branch)) continue;
      const audience = noticeAudience(db, notice, recipient);
      if (!audience) continue;
      if (notice.uncertain_count > 0 !== selection.uncertain) continue;
      taken.push({ noticeId: notice.id, audience, uncertain: notice.uncertain_count > 0 });
    }
    if (taken.length === 0) {
      pruneRetention(db, clock.now);
      return none;
    }
    const attemptId = randomUUID();
    db.prepare(
      `INSERT INTO mem_notice_attempts (id, boot_id, recipient_worktree_ref, recipient_worktree_incarnation, recipient_instance_id,
         recipient_incarnation, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(attemptId, clock.bootId, recipient.worktreeId, recipient.worktreeIncarnation, recipient.instanceId, recipient.incarnation, clock.now);
    for (const entry of taken) {
      db.prepare(
        `UPDATE mem_notices SET state = 'reserved', attempt_id = ?, attempt_audience = ?, version = version + 1
         WHERE id = ? AND state = 'pending'`
      ).run(attemptId, entry.audience, entry.noticeId);
    }
    pruneRetention(db, clock.now);
    return { attemptId, reserved: taken };
  })();
}

/**
 * The result of the send that carried an attempt (§3.5). Only the attempt's notices:
 * `sent` acknowledges them (by the audience each was reserved with), `not-sent` puts
 * them back, `indeterminate` puts them back marked. A second settle does nothing.
 * While the mode is not `on`, or when the recipient's worktree was made again, nothing
 * is acknowledged: the notices go back to pending. A rename of the recipient's worktree
 * between the reservation and the settle keeps it the same recipient.
 *
 * @returns how many notices were handled
 */
export function settleNoticeAttempt(
  db: Database.Database,
  attemptId: string,
  sendState: MemNoticeSendState,
  now: number
): number {
  return db.transaction((): number => {
    const attempt = attemptOf(db, attemptId);
    if (!attempt || attempt.settled_at !== null) return 0;
    const notices = db.prepare("SELECT * FROM mem_notices WHERE attempt_id = ? AND state = 'reserved'").all(attemptId) as MemNoticeRow[];
    // The recipient's worktree lifetime, looked up by its incarnation and never by the
    // id it was reserved under: a rename moves the row (still the same worktree), a
    // delete and re-creation removes it (review P2-1).
    const sameWorktree = worktreeIncarnationAlive(db, attempt.recipient_worktree_incarnation);
    for (const notice of notices) {
      const acknowledge = sendState === 'sent' && sameWorktree && memModeOnFor(db, [notice.repository_id], notice.branch);
      if (acknowledge) {
        db.prepare(
          `UPDATE mem_notices SET state = 'acknowledged', attempt_id = NULL, attempt_audience = NULL, acknowledged_at = ?,
             acknowledged_by = ?, acknowledged_instance_id = ?, acknowledged_incarnation = ?, version = version + 1 WHERE id = ?`
        ).run(now, notice.attempt_audience, attempt.recipient_instance_id, attempt.recipient_incarnation, notice.id);
      } else {
        db.prepare(
          `UPDATE mem_notices SET state = 'pending', attempt_id = NULL, attempt_audience = NULL,
             uncertain_count = uncertain_count + ?, version = version + 1 WHERE id = ?`
        ).run(sendState === 'indeterminate' ? 1 : 0, notice.id);
      }
    }
    db.prepare('UPDATE mem_notice_attempts SET settled_at = ?, result = ? WHERE id = ?').run(now, sendState, attemptId);
    pruneRetention(db, now);
    return notices.length;
  })();
}

export type MemHumanAcknowledgement =
  | { ok: true; notice: MemNoticeRow }
  | { ok: false; code: 'not_found' | 'version_conflict' | 'state_forbids' | 'disabled'; current?: MemNoticeRow };

/**
 * A person takes a notice from the screen's list (§3.3). Against the version the screen
 * read. A notice the list reads as pending is one a person may take: a reservation of
 * another boot or older than {@link MEM_NOTICE_ATTEMPT_STALE_MS} is put back first (as
 * `reserve` does, its +1 counted), so a sender that vanished does not hold it. A live
 * reservation still refuses (`state_forbids`).
 */
export function acknowledgeNoticeByHuman(
  db: Database.Database,
  noticeId: string,
  ifVersion: number,
  clock: MemNoticeClock
): MemHumanAcknowledgement {
  return db.transaction((): MemHumanAcknowledgement => {
    const read = getMemNotice(db, noticeId);
    if (!read) return { ok: false, code: 'not_found' };
    if (read.version !== ifVersion) return { ok: false, code: 'version_conflict', current: read };
    if (!memModeOnFor(db, [read.repository_id], read.branch)) return { ok: false, code: 'disabled', current: read };
    if (read.state === 'reserved') {
      const attempt = attemptOf(db, read.attempt_id);
      if (attempt && !attemptIsStale(attempt, clock)) return { ok: false, code: 'state_forbids', current: read };
      abandonAttemptOf(db, read, clock);
    }
    const notice = getMemNotice(db, noticeId)!;
    if (notice.state !== 'pending') return { ok: false, code: 'state_forbids', current: notice };
    db.prepare(
      `UPDATE mem_notices SET state = 'acknowledged', acknowledged_at = ?, acknowledged_by = 'human', version = version + 1
       WHERE id = ? AND version = ?`
    ).run(clock.now, noticeId, notice.version);
    pruneRetention(db, clock.now);
    return { ok: true, notice: getMemNotice(db, noticeId)! };
  })();
}
