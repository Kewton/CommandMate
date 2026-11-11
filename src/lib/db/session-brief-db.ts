/**
 * The ledger of session boundaries (Issue #4274, migration v68). SQL only; the rules
 * of when a row opens, binds, is claimed and settles are in
 * `lib/session/session-boundary` and `lib/session/session-brief`
 * (design `docs/design/session-boundary-brief-4274.md` §3).
 *
 * Every write is synchronous (better-sqlite3), so a check and the write it guards run
 * in one stretch no other send can enter. A row is keyed by (worktree, instance,
 * seq); the highest seq is the instance's current boundary.
 *
 * Reads the instance's lifetime from two places it does not own: #4221's incarnation
 * and the way #4222 records it was issued (`getInstanceIncarnationRow`), and whether the instance is on the roster
 * (`agent_instances`, SELECT only). The roster row's `created_at` is not a key: the
 * roster's full replace (`setAgentInstances`, a reorder or an alias edit) writes a
 * new one for the same instance.
 *
 * @module lib/db/session-brief-db
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { getInstanceIncarnationRow, type IncarnationIssuedBy } from '@/lib/mem/incarnation';

export type BoundaryKind = 'launch' | 'auto_restart' | 'reset' | 'resume' | 'explicit';
export type BoundaryEvidence = 'launch' | 'hook' | 'send_command' | 'explicit';
export type BoundaryState = 'pending' | 'claimed' | 'sent' | 'unknown' | 'superseded' | 'skipped';
export type BoundaryOutcome = 'not_sent' | 'unknown' | 'sent';
export type BoundarySkipReason =
  | 'off'
  | 'disabled'
  | 'target_unresolved'
  | 'empty'
  | 'over_limit'
  | 'provider_failed'
  | 'incarnation_changed'
  /** Issue #4227 (S-B): the operator chose "don't read" for this boundary on the screen (G-3). */
  | 'declined';

/** Rows kept per (worktree, instance); older ones go in the transaction that opens a row. */
export const BOUNDARY_RETAINED_ROWS = 20;

export interface BoundaryRow {
  id: string;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  instanceIncarnation: string | null;
  /** The instance was on the roster when the row opened (design §3.7). */
  onRoster: boolean;
  seq: number;
  kind: BoundaryKind;
  evidence: BoundaryEvidence;
  conversationId: string | null;
  late: boolean;
  openedAt: number;
  observationKey: string | null;
  openedBySend: string | null;
  resetSendToken: string | null;
  state: BoundaryState;
  skipReason: string | null;
  claimToken: string | null;
  attempts: number;
  lastOutcome: BoundaryOutcome | null;
  briefBytes: number | null;
  briefMode: string | null;
  includedIds: string[] | null;
  settledAt: number | null;
}

interface RawRow {
  id: string;
  worktree_id: string;
  instance_id: string;
  cli_tool_id: string;
  instance_incarnation: string | null;
  on_roster: number;
  seq: number;
  kind: BoundaryKind;
  evidence: BoundaryEvidence;
  conversation_id: string | null;
  late: number;
  opened_at: number;
  observation_key: string | null;
  opened_by_send: string | null;
  reset_send_token: string | null;
  state: BoundaryState;
  skip_reason: string | null;
  claim_token: string | null;
  attempts: number;
  last_outcome: BoundaryOutcome | null;
  brief_bytes: number | null;
  brief_mode: string | null;
  included_ids: string | null;
  settled_at: number | null;
}

function parseIds(text: string | null): string[] | null {
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : null;
  } catch {
    return null;
  }
}

function toRow(raw: RawRow): BoundaryRow {
  return {
    id: raw.id,
    worktreeId: raw.worktree_id,
    instanceId: raw.instance_id,
    cliToolId: raw.cli_tool_id,
    instanceIncarnation: raw.instance_incarnation,
    onRoster: raw.on_roster === 1,
    seq: raw.seq,
    kind: raw.kind,
    evidence: raw.evidence,
    conversationId: raw.conversation_id,
    late: raw.late === 1,
    openedAt: raw.opened_at,
    observationKey: raw.observation_key,
    openedBySend: raw.opened_by_send,
    resetSendToken: raw.reset_send_token,
    state: raw.state,
    skipReason: raw.skip_reason,
    claimToken: raw.claim_token,
    attempts: raw.attempts,
    lastOutcome: raw.last_outcome,
    briefBytes: raw.brief_bytes,
    briefMode: raw.brief_mode,
    includedIds: parseIds(raw.included_ids),
    settledAt: raw.settled_at,
  };
}

// ===========================================================================
// Reads
// ===========================================================================

/** The instance's current boundary (highest seq), or null when it has none. */
export function getCurrentBoundary(db: Database.Database, worktreeId: string, instanceId: string): BoundaryRow | null {
  const raw = db
    .prepare('SELECT * FROM session_brief_boundaries WHERE worktree_id = ? AND instance_id = ? ORDER BY seq DESC LIMIT 1')
    .get(worktreeId, instanceId) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

export function getBoundaryById(db: Database.Database, id: string): BoundaryRow | null {
  const raw = db.prepare('SELECT * FROM session_brief_boundaries WHERE id = ?').get(id) as RawRow | undefined;
  return raw ? toRow(raw) : null;
}

/**
 * The id of the worktree's newest row, any instance and any state (Issue #4224, D2 design
 * §2.4): a send's entrance keeps it as evidence that the worktree it read is still the one
 * a later step finds (a delete takes the rows with it, a rename moves them). Read only.
 */
export function getLatestWorktreeBoundaryId(db: Database.Database, worktreeId: string): string | null {
  const row = db
    .prepare('SELECT id FROM session_brief_boundaries WHERE worktree_id = ? ORDER BY opened_at DESC, seq DESC LIMIT 1')
    .get(worktreeId) as { id: string } | undefined;
  return row ? row.id : null;
}

/** The retained rows of an instance, newest first. */
export function listRetainedBoundaries(db: Database.Database, worktreeId: string, instanceId: string): BoundaryRow[] {
  return (
    db
      .prepare('SELECT * FROM session_brief_boundaries WHERE worktree_id = ? AND instance_id = ? ORDER BY seq DESC')
      .all(worktreeId, instanceId) as RawRow[]
  ).map(toRow);
}

/**
 * How long the instance has been the same thing (design §3.7): #4221's incarnation,
 * how it was issued (#4222's `issued_by`), and whether the instance is on the roster.
 */
export interface InstanceLifetime {
  incarnation: string | null;
  /** The tool #4221's incarnation row names, or null without one. */
  incarnationToolId: string | null;
  /** `issued_by` of the incarnation row (`lazy`: mem's late issue or a primary copied into the first roster save). */
  incarnationIssuedBy: IncarnationIssuedBy | null;
  /** On the roster (`agent_instances`); a primary not saved there is not. */
  onRoster: boolean;
}

export function readInstanceLifetime(db: Database.Database, worktreeId: string, instanceId: string): InstanceLifetime {
  const incarnation = getInstanceIncarnationRow(db, worktreeId, instanceId);
  const roster = db
    .prepare('SELECT 1 AS present FROM agent_instances WHERE worktree_id = ? AND instance_id = ?')
    .get(worktreeId, instanceId) as { present: number } | undefined;
  return {
    incarnation: incarnation?.incarnation ?? null,
    incarnationToolId: incarnation?.cliToolId ?? null,
    incarnationIssuedBy: incarnation?.issuedBy ?? null,
    onRoster: roster !== undefined,
  };
}

/**
 * Whether `now` is the same lifetime of the instance as `earlier` (design §3.7,
 * consistency reviews 2 and 2b). The key is #4221's incarnation: a delete ends it,
 * an add starts another, and the roster's full replace keeps it.
 *
 *  - An incarnation `earlier` has: equal is the answer.
 *  - None then: leaving the roster ends the lifetime (a delete of an instance that
 *    never had an incarnation leaves none to end — the roster is what shows it).
 *    Otherwise none now is the same (a full replace keeps it at none; an add would
 *    have started one), and one now is the same only when #4222 says it was issued
 *    `lazy` (mem's first write, or a primary copied into the first roster save) for
 *    the same tool. `roster` (a new pair: a delete and re-add) and NULL (before v67)
 *    are another lifetime.
 */
export function isSameInstanceLifetime(
  earlier: Pick<InstanceLifetime, 'incarnation' | 'onRoster'>,
  now: InstanceLifetime,
  cliToolId: string
): boolean {
  if (earlier.incarnation !== null) return earlier.incarnation === now.incarnation;
  if (earlier.onRoster && !now.onRoster) return false;
  if (now.incarnation === null) return earlier.onRoster === now.onRoster;
  return now.incarnationIssuedBy === 'lazy' && now.incarnationToolId === cliToolId;
}

// ===========================================================================
// Writes
// ===========================================================================

export interface OpenBoundaryInput {
  /** Given by an explicit open, which plans the request before the row exists. */
  id?: string;
  worktreeId: string;
  instanceId: string;
  cliToolId: string;
  lifetime: InstanceLifetime;
  kind: BoundaryKind;
  evidence: BoundaryEvidence;
  conversationId?: string | null;
  late?: boolean;
  openedAt: number;
  observationKey?: string | null;
  openedBySend?: string | null;
  resetSendToken?: string | null;
}

/**
 * Open a boundary: the earlier `pending` rows of the instance are superseded (a brief
 * of an older boundary never lands mid-way through a later conversation), and rows
 * beyond {@link BOUNDARY_RETAINED_ROWS} are dropped, in one transaction.
 */
export function openBoundary(db: Database.Database, input: OpenBoundaryInput): BoundaryRow {
  const id = input.id ?? randomUUID();
  db.transaction(() => {
    const max = db
      .prepare('SELECT MAX(seq) AS seq FROM session_brief_boundaries WHERE worktree_id = ? AND instance_id = ?')
      .get(input.worktreeId, input.instanceId) as { seq: number | null };
    const seq = (max.seq ?? 0) + 1;
    db.prepare(
      `UPDATE session_brief_boundaries SET state = 'superseded', settled_at = ?
       WHERE worktree_id = ? AND instance_id = ? AND state = 'pending'`
    ).run(input.openedAt, input.worktreeId, input.instanceId);
    db.prepare(
      `INSERT INTO session_brief_boundaries (id, worktree_id, instance_id, cli_tool_id, instance_incarnation, on_roster,
         seq, kind, evidence, conversation_id, late, opened_at, observation_key, opened_by_send, reset_send_token, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`
    ).run(
      id,
      input.worktreeId,
      input.instanceId,
      input.cliToolId,
      input.lifetime.incarnation,
      input.lifetime.onRoster ? 1 : 0,
      seq,
      input.kind,
      input.evidence,
      input.conversationId ?? null,
      input.late ? 1 : 0,
      input.openedAt,
      input.observationKey ?? null,
      input.openedBySend ?? null,
      input.resetSendToken ?? null
    );
    db.prepare(
      'DELETE FROM session_brief_boundaries WHERE worktree_id = ? AND instance_id = ? AND seq <= ?'
    ).run(input.worktreeId, input.instanceId, seq - BOUNDARY_RETAINED_ROWS);
  })();
  return getBoundaryById(db, id)!;
}

/** Tie the agent's conversation id (and the hook that named it) to a row that had none. */
export function bindBoundaryConversation(
  db: Database.Database,
  id: string,
  conversationId: string,
  observationKey: string | null
): boolean {
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET conversation_id = ?, observation_key = COALESCE(?, observation_key)
         WHERE id = ? AND conversation_id IS NULL`
      )
      .run(conversationId, observationKey, id).changes === 1
  );
}

/** A reset a hook opened is the one this send typed (design §3.3): no second row. */
export function adoptBoundaryAsSendReset(db: Database.Database, id: string, resetSendToken: string): boolean {
  return (
    db
      .prepare('UPDATE session_brief_boundaries SET reset_send_token = ? WHERE id = ? AND reset_send_token IS NULL')
      .run(resetSendToken, id).changes === 1
  );
}

/** A row opened before #4221 issued the instance's incarnation gets it (same lifetime, design §3.7). */
export function fillBoundaryIncarnation(db: Database.Database, id: string, incarnation: string): boolean {
  return (
    db
      .prepare('UPDATE session_brief_boundaries SET instance_incarnation = ? WHERE id = ? AND instance_incarnation IS NULL')
      .run(incarnation, id).changes === 1
  );
}

/**
 * Claim a pending boundary for one send. The one place "once" is decided: a second
 * send finds the state no longer `pending`, or a newer incarnation, and changes nothing.
 * Only the instance's current row (highest seq): once a newer boundary is open, an
 * older one planned before it is not claimed (consistency review 1).
 */
export function claimBoundary(
  db: Database.Database,
  id: string,
  claimToken: string,
  incarnation: string | null
): boolean {
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET state = 'claimed', claim_token = ?
         WHERE id = ? AND state = 'pending' AND instance_incarnation IS ?
           AND seq = (SELECT MAX(newer.seq) FROM session_brief_boundaries AS newer
                      WHERE newer.worktree_id = session_brief_boundaries.worktree_id
                        AND newer.instance_id = session_brief_boundaries.instance_id)`
      )
      .run(claimToken, id, incarnation).changes === 1
  );
}

/** Leave the boundary unbriefed for this reason (design §7). Only from `pending`. */
export function skipBoundary(db: Database.Database, id: string, reason: BoundarySkipReason, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET state = 'skipped', skip_reason = ?, settled_at = ?
         WHERE id = ? AND state = 'pending'`
      )
      .run(reason, now, id).changes === 1
  );
}

export interface DeliveredBrief {
  bytes: number;
  mode: string;
  includedIds: string[];
}

/**
 * Settle a claim with the send's outcome (design §3.4 table): `not_sent` puts it back
 * to `pending` (nothing typed is not "read") — or `superseded` when a newer boundary
 * opened meanwhile (a relaunch inside the send; consistency review 1), as opening one
 * does to a pending row — `unknown` keeps it from being sent again, `sent` records
 * what was typed. Only the claim's own token can.
 */
export function settleBoundaryClaim(
  db: Database.Database,
  id: string,
  claimToken: string,
  outcome: BoundaryOutcome,
  brief: DeliveredBrief | null,
  now: number
): boolean {
  if (outcome === 'not_sent') {
    const row = getBoundaryById(db, id);
    if (!row || row.state !== 'claimed' || row.claimToken !== claimToken) return false;
    const current = getCurrentBoundary(db, row.worktreeId, row.instanceId);
    const stillCurrent = current?.id === id;
    return (
      db
        .prepare(
          `UPDATE session_brief_boundaries SET state = ?, settled_at = ?, claim_token = NULL, attempts = attempts + 1,
             last_outcome = 'not_sent'
           WHERE id = ? AND state = 'claimed' AND claim_token = ?`
        )
        .run(stillCurrent ? 'pending' : 'superseded', stillCurrent ? null : now, id, claimToken).changes === 1
    );
  }
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET state = ?, last_outcome = ?, settled_at = ?,
           brief_bytes = ?, brief_mode = ?, included_ids = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(
        outcome,
        outcome,
        now,
        brief?.bytes ?? null,
        brief?.mode ?? null,
        outcome === 'sent' && brief ? JSON.stringify(brief.includedIds) : null,
        id,
        claimToken
      ).changes === 1
  );
}

/**
 * A claim left by a process that is gone (a server restart mid-send): whether it was
 * typed cannot be told, so it is `unknown` — never sent twice (design §3.5).
 */
/**
 * Issue #4227 (S-B, design §3.2): a `decline` claim whose body was typed (`sent`) or may have
 * been (`unknown`) uses the boundary up as `skipped(declined)` — only the claim this send
 * holds (`claimed` with the same token). A body that never went in (`not_sent`) is
 * {@link settleBoundaryClaim}'s, which puts the row back to `pending`.
 *
 * pr3f (S-B-commit): `full`'s empty brief is claimed the same way and settled here as
 * `skipped(empty)` (`reason`), never used up before the body went in.
 */
export function settleDeclinedClaim(
  db: Database.Database,
  id: string,
  claimToken: string,
  now: number,
  reason: Extract<BoundarySkipReason, 'declined' | 'empty'> = 'declined'
): boolean {
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET state = 'skipped', skip_reason = ?, settled_at = ?, claim_token = NULL
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(reason, now, id, claimToken).changes === 1
  );
}

export function settleStaleClaim(db: Database.Database, id: string, claimToken: string, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE session_brief_boundaries SET state = 'unknown', last_outcome = 'unknown', settled_at = ?
         WHERE id = ? AND state = 'claimed' AND claim_token = ?`
      )
      .run(now, id, claimToken).changes === 1
  );
}

/**
 * A send that typed its brief and relaunched the agent inside (design §3.5): the
 * launch rows that relaunch opened carry the same record, so the next send does not
 * brief the new process again. Only rows this send opened, never a later reset.
 */
export function copyDeliveryToRelaunchBoundaries(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  claimToken: string,
  brief: DeliveredBrief,
  now: number
): number {
  return db
    .prepare(
      `UPDATE session_brief_boundaries SET state = 'sent', last_outcome = 'sent', settled_at = ?,
         brief_bytes = ?, brief_mode = ?, included_ids = ?
       WHERE worktree_id = ? AND instance_id = ? AND opened_by_send = ? AND state = 'pending'
         AND kind IN ('launch', 'auto_restart')`
    )
    .run(now, brief.bytes, brief.mode, JSON.stringify(brief.includedIds), worktreeId, instanceId, claimToken).changes;
}
