/**
 * Minimal Skill operation audit (Issue #1234, Phase 1)
 *
 * Append-only writes to `skill_operations`. Every install/uninstall lands one
 * row per outcome, carrying the source coordinates that make the change
 * traceable to an immutable commit and artifact digest, plus the actor and the
 * typed result.
 *
 * Two properties are load-bearing:
 * - **Append-only** is enforced by database triggers (migration v44), so a
 *   later bug cannot rewrite the log. `recordSkillOperationAudit` only inserts.
 * - **Redaction** happens on the way in, not on the way out, so a signed URL or
 *   a home directory path never reaches the table in the first place.
 *
 * @module lib/skills/operation-audit
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import { redactSkillOperationText } from '@/lib/skills/operation-store';
import type {
  SkillOperationJournalEntry,
  SkillOperationKind,
  SkillOperationState,
} from '@/lib/skills/operation-journal';

/** Outcome recorded for one audit event. */
export type SkillOperationAuditResult = 'succeeded' | 'failed' | 'reconciled';

/** An audit row as stored. */
export interface SkillOperationAuditRecord {
  id: string;
  operationId: string;
  idempotencyKey: string;
  bindingHash: string;
  operation: SkillOperationKind;
  state: SkillOperationState;
  result: SkillOperationAuditResult;
  actorType: string;
  actorId: string | null;
  worktreeId: string;
  skillId: string;
  skillVersion: string | null;
  /** Version present before the operation; null when nothing was installed. */
  fromVersion: string | null;
  /** Version present after the operation; null for an uninstall. */
  toVersion: string | null;
  sourceOrigin: string | null;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceCommit: string | null;
  artifactSha256: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  recordedAt: number;
}

/** Input for one audit append. */
export type SkillOperationAuditInput = Omit<SkillOperationAuditRecord, 'id' | 'recordedAt'> & {
  recordedAt?: number;
};

interface SkillOperationRow {
  id: string;
  operation_id: string;
  idempotency_key: string;
  binding_hash: string;
  operation: string;
  state: string;
  result: string;
  actor_type: string;
  actor_id: string | null;
  worktree_id: string;
  skill_id: string;
  skill_version: string | null;
  from_version: string | null;
  to_version: string | null;
  source_origin: string | null;
  source_repository: string | null;
  source_ref: string | null;
  source_commit: string | null;
  artifact_sha256: string | null;
  error_code: string | null;
  error_message: string | null;
  recorded_at: number;
}

function mapRow(row: SkillOperationRow): SkillOperationAuditRecord {
  return {
    id: row.id,
    operationId: row.operation_id,
    idempotencyKey: row.idempotency_key,
    bindingHash: row.binding_hash,
    operation: row.operation as SkillOperationKind,
    state: row.state as SkillOperationState,
    result: row.result as SkillOperationAuditResult,
    actorType: row.actor_type,
    actorId: row.actor_id,
    worktreeId: row.worktree_id,
    skillId: row.skill_id,
    skillVersion: row.skill_version,
    fromVersion: row.from_version,
    toVersion: row.to_version,
    sourceOrigin: row.source_origin,
    sourceRepository: row.source_repository,
    sourceRef: row.source_ref,
    sourceCommit: row.source_commit,
    artifactSha256: row.artifact_sha256,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    recordedAt: row.recorded_at,
  };
}

const SELECT_COLUMNS = `
  id, operation_id, idempotency_key, binding_hash, operation, state, result,
  actor_type, actor_id, worktree_id, skill_id, skill_version, from_version, to_version,
  source_origin, source_repository, source_ref, source_commit, artifact_sha256,
  error_code, error_message, recorded_at
`;

/**
 * Build an audit input from a journal entry, so the two records cannot drift.
 * The journal already holds the actor, target, source and typed error.
 *
 * The version transition (#1248) is derived from the journal rather than passed
 * in, because the journal fully determines it: an install ends at its target
 * version and starts nowhere, an uninstall starts at the version it removes and
 * ends nowhere, and an update (#1244) records the version it replaces on its
 * own target (`fromVersion`) precisely so this derivation stays total.
 */
export function buildSkillOperationAuditInput(
  entry: SkillOperationJournalEntry,
  result: SkillOperationAuditResult,
  recordedAt?: number
): SkillOperationAuditInput {
  const isUninstall = entry.operation === 'uninstall';
  return {
    operationId: entry.operationId,
    idempotencyKey: entry.idempotencyKey,
    bindingHash: entry.bindingHash,
    operation: entry.operation,
    state: entry.state,
    result,
    actorType: entry.actor.type,
    actorId: entry.actor.id,
    worktreeId: entry.target.worktreeId,
    skillId: entry.target.skillId,
    skillVersion: entry.target.version,
    fromVersion: isUninstall ? entry.target.version : (entry.target.fromVersion ?? null),
    toVersion: isUninstall ? null : entry.target.version,
    sourceOrigin: entry.source?.origin ?? null,
    sourceRepository: entry.source?.repository ?? null,
    sourceRef: entry.source?.ref ?? null,
    sourceCommit: entry.source?.commit ?? null,
    artifactSha256: entry.source?.artifactSha256 ?? null,
    errorCode: entry.error?.code ?? null,
    errorMessage: entry.error?.message ?? null,
    recordedAt,
  };
}

/** Append one audit event. Never updates: repeated outcomes add rows. */
export function recordSkillOperationAudit(
  db: Database.Database,
  input: SkillOperationAuditInput
): SkillOperationAuditRecord {
  const record: SkillOperationAuditRecord = {
    ...input,
    id: randomUUID(),
    errorMessage:
      input.errorMessage === null ? null : redactSkillOperationText(input.errorMessage),
    recordedAt: input.recordedAt ?? Date.now(),
  };

  db.prepare(
    `INSERT INTO skill_operations (
      id, operation_id, idempotency_key, binding_hash, operation, state, result,
      actor_type, actor_id, worktree_id, skill_id, skill_version, from_version, to_version,
      source_origin, source_repository, source_ref, source_commit, artifact_sha256,
      error_code, error_message, recorded_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    record.id,
    record.operationId,
    record.idempotencyKey,
    record.bindingHash,
    record.operation,
    record.state,
    record.result,
    record.actorType,
    record.actorId,
    record.worktreeId,
    record.skillId,
    record.skillVersion,
    record.fromVersion,
    record.toVersion,
    record.sourceOrigin,
    record.sourceRepository,
    record.sourceRef,
    record.sourceCommit,
    record.artifactSha256,
    record.errorCode,
    record.errorMessage,
    record.recordedAt
  );

  return record;
}

/** Audit trail of one operation, oldest first. */
export function getSkillOperationAuditByOperationId(
  db: Database.Database,
  operationId: string
): SkillOperationAuditRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM skill_operations
       WHERE operation_id = ? ORDER BY recorded_at ASC, id ASC`
    )
    .all(operationId) as SkillOperationRow[];
  return rows.map(mapRow);
}

/** Default page size for an audit query. */
export const SKILL_AUDIT_DEFAULT_LIMIT = 50;

/** Hard ceiling on one audit page, so a client cannot ask for the whole log. */
export const SKILL_AUDIT_MAX_LIMIT = 200;

/**
 * Position in the newest-first feed, as the last row of the previous page.
 *
 * A bare timestamp would be ambiguous: two rows can share `recorded_at`, and a
 * cursor that only compared timestamps would either skip or repeat them. The ID
 * is the tiebreak, matching the `(recorded_at DESC, id DESC)` ordering exactly.
 */
export interface SkillOperationAuditCursor {
  recordedAt: number;
  id: string;
}

/** What to select from the log. Every field narrows; omitting all reads everything. */
export interface SkillOperationAuditQuery {
  /** Omit to read across every worktree — what the dashboard feed does. */
  worktreeId?: string;
  skillId?: string;
  operation?: SkillOperationKind;
  result?: SkillOperationAuditResult;
  /** Inclusive lower bound on `recordedAt`. */
  since?: number;
  /** Exclusive upper bound on `recordedAt`. */
  until?: number;
  /** Read the page immediately after this position. */
  after?: SkillOperationAuditCursor;
  limit?: number;
}

/** One page of the feed. */
export interface SkillOperationAuditPage {
  records: SkillOperationAuditRecord[];
  /** Another page exists behind this one. */
  hasMore: boolean;
  /** Position to pass back as `after`, or null when the feed is exhausted. */
  nextCursor: SkillOperationAuditCursor | null;
}

function buildAuditWhere(query: SkillOperationAuditQuery): {
  clause: string;
  params: Array<string | number>;
} {
  const conditions: string[] = [];
  const params: Array<string | number> = [];

  if (query.worktreeId !== undefined) {
    conditions.push('worktree_id = ?');
    params.push(query.worktreeId);
  }
  if (query.skillId !== undefined) {
    conditions.push('skill_id = ?');
    params.push(query.skillId);
  }
  if (query.operation !== undefined) {
    conditions.push('operation = ?');
    params.push(query.operation);
  }
  if (query.result !== undefined) {
    conditions.push('result = ?');
    params.push(query.result);
  }
  if (query.since !== undefined) {
    conditions.push('recorded_at >= ?');
    params.push(query.since);
  }
  if (query.until !== undefined) {
    conditions.push('recorded_at < ?');
    params.push(query.until);
  }
  if (query.after !== undefined) {
    conditions.push('(recorded_at < ? OR (recorded_at = ? AND id < ?))');
    params.push(query.after.recordedAt, query.after.recordedAt, query.after.id);
  }

  return {
    clause: conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * One page of the audit feed, newest first.
 *
 * Fetches one row beyond the page to decide `hasMore` without a second COUNT
 * over a table that only ever grows.
 */
export function querySkillOperationAudit(
  db: Database.Database,
  query: SkillOperationAuditQuery = {}
): SkillOperationAuditPage {
  const limit = Math.min(
    Math.max(1, Math.trunc(query.limit ?? SKILL_AUDIT_DEFAULT_LIMIT)),
    SKILL_AUDIT_MAX_LIMIT
  );
  const { clause, params } = buildAuditWhere(query);

  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM skill_operations
       ${clause}
       ORDER BY recorded_at DESC, id DESC LIMIT ?`
    )
    .all(...params, limit + 1) as SkillOperationRow[];

  const hasMore = rows.length > limit;
  const records = (hasMore ? rows.slice(0, limit) : rows).map(mapRow);
  const last = records[records.length - 1];

  return {
    records,
    hasMore,
    nextCursor: hasMore && last ? { recordedAt: last.recordedAt, id: last.id } : null,
  };
}

/** Audit trail for one Skill in one worktree, newest first. */
export function listSkillOperationAudit(
  db: Database.Database,
  filter: { worktreeId: string; skillId?: string; limit?: number }
): SkillOperationAuditRecord[] {
  return querySkillOperationAudit(db, {
    worktreeId: filter.worktreeId,
    skillId: filter.skillId,
    limit: filter.limit ?? 100,
  }).records;
}
