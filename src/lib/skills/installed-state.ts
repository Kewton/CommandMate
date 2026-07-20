/**
 * Installed-Skill index (Issue #1235)
 *
 * A lookup table over what the receipts already say. The receipt inside
 * `.agents/skills/<id>/` is the truth; this table exists so "what is installed
 * in this worktree" does not require walking every registered worktree.
 *
 * That ordering is the whole point. The row is written *after* the atomic
 * rename, so a crash in between leaves a worktree that is installed and a table
 * that has not caught up — which #1234 reconciliation converges forward from the
 * receipt. Writing the row first would create the opposite and unrecoverable
 * state: a table claiming an install that does not exist.
 *
 * {@link upsertSkillInstallation} is therefore idempotent by construction, so
 * reconciliation may replay it any number of times.
 *
 * @module lib/skills/installed-state
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';
import type { SkillInstallReceipt, SkillRiskLevel } from '@/types/skills';

/** One indexed install. Repository-relative paths only. */
export interface SkillInstallationRecord {
  id: string;
  worktreeId: string;
  skillId: string;
  version: string;
  installRoot: string;
  receiptSha256: string;
  sourceRepository: string;
  sourceRef: string;
  sourceCommit: string;
  artifactSha256: string;
  effectiveRisk: SkillRiskLevel;
  operationId: string;
  installedAt: number;
  updatedAt: number;
}

interface SkillInstallationRow {
  id: string;
  worktree_id: string;
  skill_id: string;
  version: string;
  install_root: string;
  receipt_sha256: string;
  source_repository: string;
  source_ref: string;
  source_commit: string;
  artifact_sha256: string;
  effective_risk: string;
  operation_id: string;
  installed_at: number;
  updated_at: number;
}

const SELECT_COLUMNS = `
  id, worktree_id, skill_id, version, install_root, receipt_sha256,
  source_repository, source_ref, source_commit, artifact_sha256,
  effective_risk, operation_id, installed_at, updated_at
`;

function mapRow(row: SkillInstallationRow): SkillInstallationRecord {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    skillId: row.skill_id,
    version: row.version,
    installRoot: row.install_root,
    receiptSha256: row.receipt_sha256,
    sourceRepository: row.source_repository,
    sourceRef: row.source_ref,
    sourceCommit: row.source_commit,
    artifactSha256: row.artifact_sha256,
    effectiveRisk: row.effective_risk as SkillRiskLevel,
    operationId: row.operation_id,
    installedAt: row.installed_at,
    updatedAt: row.updated_at,
  };
}

/** What an index write is derived from: the receipt that actually landed. */
export interface SkillInstallationInput {
  worktreeId: string;
  receipt: SkillInstallReceipt;
  /** Digest of the exact receipt bytes on disk. */
  receiptSha256: string;
  operationId: string;
  installedAt: number;
}

/**
 * Record an install, replacing any earlier row for the same (worktree, skill).
 *
 * Idempotent: replaying the same operation rewrites the same values, so
 * reconciliation can call this without first having to know whether an earlier
 * attempt got this far. `installed_at` is preserved across replays so the
 * original commit time is not rewritten by a later convergence.
 */
export function upsertSkillInstallation(
  db: Database.Database,
  input: SkillInstallationInput
): SkillInstallationRecord {
  const { receipt } = input;
  db.prepare(
    `INSERT INTO skill_installations (
       id, worktree_id, skill_id, version, install_root, receipt_sha256,
       source_repository, source_ref, source_commit, artifact_sha256,
       effective_risk, operation_id, installed_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (worktree_id, skill_id) DO UPDATE SET
       version = excluded.version,
       install_root = excluded.install_root,
       receipt_sha256 = excluded.receipt_sha256,
       source_repository = excluded.source_repository,
       source_ref = excluded.source_ref,
       source_commit = excluded.source_commit,
       artifact_sha256 = excluded.artifact_sha256,
       effective_risk = excluded.effective_risk,
       operation_id = excluded.operation_id,
       updated_at = excluded.updated_at`
  ).run(
    randomUUID(),
    input.worktreeId,
    receipt.skill_id,
    receipt.version,
    receipt.install_root,
    input.receiptSha256,
    receipt.source.repository,
    receipt.source.ref,
    receipt.source.commit,
    receipt.artifact.sha256,
    receipt.effective_risk,
    input.operationId,
    input.installedAt,
    input.installedAt
  );

  const record = getSkillInstallation(db, input.worktreeId, receipt.skill_id);
  if (record === null) {
    throw new Error('Skill installation row disappeared immediately after being written');
  }
  return record;
}

/** The indexed install for one Skill in one worktree, or null. */
export function getSkillInstallation(
  db: Database.Database,
  worktreeId: string,
  skillId: string
): SkillInstallationRecord | null {
  const row = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM skill_installations
       WHERE worktree_id = ? AND skill_id = ?`
    )
    .get(worktreeId, skillId) as SkillInstallationRow | undefined;
  return row ? mapRow(row) : null;
}

/** Every indexed install in one worktree, by Skill ID. */
export function listSkillInstallations(
  db: Database.Database,
  worktreeId: string
): SkillInstallationRecord[] {
  const rows = db
    .prepare(
      `SELECT ${SELECT_COLUMNS} FROM skill_installations
       WHERE worktree_id = ? ORDER BY skill_id ASC`
    )
    .all(worktreeId) as SkillInstallationRow[];
  return rows.map(mapRow);
}

/** Drop an index row. Returns whether a row was removed. */
export function deleteSkillInstallation(
  db: Database.Database,
  worktreeId: string,
  skillId: string
): boolean {
  const result = db
    .prepare('DELETE FROM skill_installations WHERE worktree_id = ? AND skill_id = ?')
    .run(worktreeId, skillId);
  return result.changes > 0;
}
