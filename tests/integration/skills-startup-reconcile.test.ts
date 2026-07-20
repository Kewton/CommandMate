/**
 * Issue #1428: the startup wiring that #1234 shipped without.
 *
 * These tests drive {@link runSkillStartupReconciliation} — the exact function
 * `server.ts` calls after migrations — against a real database, a real journal
 * on disk and a real receipt in a real worktree tree. Nothing here reaches into
 * the reconciler with hand-built ports; the whole point is to cross the same
 * assembly seam production crosses, because the Phase 1 gap (a reconciler that
 * was never invoked) survived precisely because every test until now called the
 * library directly.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { computeSha256Hex } from '@/lib/skills/integrity';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import {
  beginSkillOperation,
  readSkillOperationJournal,
  transitionSkillOperation,
  listSkillOperationJournal,
  type SkillOperationBinding,
  type SkillOperationSource,
} from '@/lib/skills/operation-journal';
import { buildSkillOperationLockKey } from '@/lib/skills/operation-lock';
import {
  getSkillInstallation,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import { getSkillOperationAuditByOperationId } from '@/lib/skills/operation-audit';
import { runSkillStartupReconciliation } from '@/lib/skills/startup-reconcile';
import { seedWorktreeRow } from './skills/mvp-harness';
import type { SkillInstallReceipt } from '@/types/skills';

const T0 = 1_800_000_000_000;
const WORKTREE_ID = 'wt-1';
const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const INSTALL_ROOT_REL = `.agents/skills/${SKILL_ID}`;

let db: Database.Database;
let root: string;
let worktreeDir: string;
let receiptBytes: Buffer;
let receiptDigest: string;

const SOURCE: SkillOperationSource = {
  origin: 'github-release',
  repository: 'Kewton/commandmate-skills',
  ref: 'demo-skill-v1.2.3',
  commit: 'b'.repeat(40),
  artifactSha256: 'c'.repeat(64),
};

function installBinding(planHash = 'a'.repeat(64)): SkillOperationBinding {
  return {
    actor: { type: 'user', id: 'user-1' },
    operation: 'install',
    target: { worktreeId: WORKTREE_ID, skillId: SKILL_ID, version: VERSION },
    planHash,
  };
}

function uninstallBinding(planHash = 'd'.repeat(64)): SkillOperationBinding {
  return {
    actor: { type: 'user', id: 'user-1' },
    operation: 'uninstall',
    target: { worktreeId: WORKTREE_ID, skillId: SKILL_ID, version: VERSION },
    planHash,
  };
}

/** A receipt with every field the reindex port reads, written to the worktree. */
function buildReceipt(): SkillInstallReceipt {
  return {
    schema_version: 1,
    skill_id: SKILL_ID,
    version: VERSION,
    install_root: INSTALL_ROOT_REL,
    source: { repository: SOURCE.repository, ref: SOURCE.ref, commit: SOURCE.commit },
    artifact: { asset_name: 'demo.tar.gz', sha256: SOURCE.artifactSha256, size: 10, format: 'tar.gz' },
    files: [{ path: 'SKILL.md', sha256: 'e'.repeat(64), size: 4, executable: false }],
    declared_risk: 'low',
    computed_risk: 'low',
    effective_risk: 'low',
    declared_permissions: [],
    agent_compatibility: [],
  } as unknown as SkillInstallReceipt;
}

function writeReceiptOnDisk(): void {
  const installRootAbs = join(worktreeDir, '.agents', 'skills', SKILL_ID);
  mkdirSync(installRootAbs, { recursive: true });
  receiptBytes = Buffer.from(JSON.stringify(buildReceipt()), 'utf-8');
  receiptDigest = computeSha256Hex(receiptBytes);
  writeFileSync(join(installRootAbs, SKILL_RECEIPT_FILENAME), receiptBytes);
}

function reconcile(now: number, retentionMs?: number) {
  return runSkillStartupReconciliation(db, {
    root,
    now,
    isProcessAlive: () => false,
    retentionMs,
    resolveWorktreePath: () => worktreeDir,
  });
}

/** Create an operation left in `committed_reconciling`: rename landed, index write threw. */
function seedCommittedReconciling(binding: SkillOperationBinding, key: string): string {
  const begun = beginSkillOperation(
    { idempotencyKey: key, binding, lockKey: buildSkillOperationLockKey(worktreeDir, SKILL_ID), source: SOURCE },
    { root, now: T0 }
  );
  if (!begun.ok) throw new Error('failed to open journal entry');
  let entry = transitionSkillOperation(begun.entry, 'FS_COMMITTED', { receiptDigest }, { root, now: T0 + 1 });
  entry = transitionSkillOperation(
    entry,
    'FAILED_RECONCILABLE',
    { error: { code: 'SKILL_INSTALL_INDEX_FAILED', message: 'database is locked' } },
    { root, now: T0 + 2 }
  );
  return entry.operationId;
}

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  root = mkdtempSync(join(tmpdir(), 'cm-startup-reconcile-'));
  worktreeDir = mkdtempSync(join(tmpdir(), 'cm-startup-wt-'));
  // Since #1430 skill_installations.worktree_id is a foreign key, so the parent
  // worktrees row the reindex port writes against must exist — in production the
  // route and the reconciler resolve it from the same connection.
  seedWorktreeRow(db, worktreeDir, WORKTREE_ID);
  writeReceiptOnDisk();
});

afterEach(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  rmSync(worktreeDir, { recursive: true, force: true });
});

describe('startup reconciliation converges an interrupted install through the production ports', () => {
  it('drives committed_reconciling to SUCCEEDED and rebuilds the index row from the receipt', () => {
    const operationId = seedCommittedReconciling(installBinding(), 'inst-1');
    // The index write never landed before the crash.
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).toBeNull();

    const report = reconcile(T0 + 100);

    expect(report.converged).toBe(1);
    expect(readSkillOperationJournal('inst-1', { root })?.state).toBe('SUCCEEDED');

    // The real reindex port read the on-disk receipt and wrote the row — this is
    // the wiring that was missing, proven end to end rather than mocked.
    const row = getSkillInstallation(db, WORKTREE_ID, SKILL_ID);
    expect(row).not.toBeNull();
    expect(row?.version).toBe(VERSION);
    expect(row?.receiptSha256).toBe(receiptDigest);

    const trail = getSkillOperationAuditByOperationId(db, operationId);
    expect(trail.map((r) => r.result)).toEqual(['reconciled']);
    expect(trail[0].state).toBe('SUCCEEDED');
  });

  it('marks a genuinely rolled-back install as failed when no receipt is on disk', () => {
    rmSync(join(worktreeDir, '.agents'), { recursive: true, force: true });
    const begun = beginSkillOperation(
      { idempotencyKey: 'inst-2', binding: installBinding(), lockKey: 'lk', source: SOURCE },
      { root, now: T0 }
    );
    expect(begun.ok).toBe(true);

    const report = reconcile(T0 + 100);

    expect(report.failed).toBe(1);
    expect(readSkillOperationJournal('inst-2', { root })?.state).toBe('FAILED_RECONCILABLE');
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).toBeNull();
  });
});

describe('startup reconciliation converges an interrupted uninstall through the production ports', () => {
  it('drives committed_reconciling to SUCCEEDED and drops the index row', () => {
    upsertSkillInstallation(db, {
      worktreeId: WORKTREE_ID,
      receipt: buildReceipt(),
      receiptSha256: receiptDigest,
      operationId: 'prior-install',
      installedAt: T0 - 1000,
    });
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).not.toBeNull();

    seedCommittedReconciling(uninstallBinding(), 'uninst-1');

    const report = reconcile(T0 + 100);

    expect(report.converged).toBe(1);
    expect(readSkillOperationJournal('uninst-1', { root })?.state).toBe('SUCCEEDED');
    // The uninstall reindex port dropped the row.
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).toBeNull();
  });
});

describe('retention keeps the journal directory from growing without bound', () => {
  it('prunes terminal entries past the window and makes the key reusable', () => {
    // A success recorded long ago.
    const begun = beginSkillOperation(
      { idempotencyKey: 'old-success', binding: installBinding(), lockKey: 'lk', source: SOURCE },
      { root, now: T0 }
    );
    if (!begun.ok) throw new Error('seed failed');
    let entry = transitionSkillOperation(begun.entry, 'FS_COMMITTED', { receiptDigest }, { root, now: T0 });
    entry = transitionSkillOperation(entry, 'INDEXED', {}, { root, now: T0 });
    transitionSkillOperation(entry, 'SUCCEEDED', { error: null }, { root, now: T0 });

    const retentionMs = 1000;
    const report = reconcile(T0 + retentionMs + 1, retentionMs);

    expect(report.prunedKeys).toContain('old-success');
    expect(readSkillOperationJournal('old-success', { root })).toBeNull();

    // The idempotency key is free again: a new request opens a fresh entry
    // rather than replaying the collected one.
    const reopened = beginSkillOperation(
      { idempotencyKey: 'old-success', binding: installBinding(), lockKey: 'lk', source: SOURCE },
      { root, now: T0 + retentionMs + 2 }
    );
    expect(reopened.ok).toBe(true);
    if (reopened.ok) expect(reopened.replayed).toBe(false);
  });

  it('keeps a fresh terminal entry and a still-reconcilable entry', () => {
    // Fresh success: inside the window.
    const fresh = beginSkillOperation(
      { idempotencyKey: 'fresh', binding: installBinding('1'.repeat(64)), lockKey: 'lk', source: SOURCE },
      { root, now: T0 + 100 }
    );
    if (!fresh.ok) throw new Error('seed failed');
    let e = transitionSkillOperation(fresh.entry, 'FS_COMMITTED', { receiptDigest }, { root, now: T0 + 100 });
    e = transitionSkillOperation(e, 'INDEXED', {}, { root, now: T0 + 100 });
    transitionSkillOperation(e, 'SUCCEEDED', { error: null }, { root, now: T0 + 100 });

    const report = reconcile(T0 + 200, 1000);

    expect(report.prunedKeys).toEqual([]);
    expect(readSkillOperationJournal('fresh', { root })?.state).toBe('SUCCEEDED');
    expect(listSkillOperationJournal({ root })).toHaveLength(1);
  });

  it('does not let file count scale with total operations over time', () => {
    for (let i = 0; i < 5; i += 1) {
      const b = beginSkillOperation(
        {
          idempotencyKey: `op-${i}`,
          binding: installBinding(String(i).repeat(64).slice(0, 64)),
          lockKey: 'lk',
          source: SOURCE,
        },
        { root, now: T0 }
      );
      if (!b.ok) throw new Error('seed failed');
      let e = transitionSkillOperation(b.entry, 'FS_COMMITTED', { receiptDigest }, { root, now: T0 });
      e = transitionSkillOperation(e, 'INDEXED', {}, { root, now: T0 });
      transitionSkillOperation(e, 'SUCCEEDED', { error: null }, { root, now: T0 });
    }
    expect(listSkillOperationJournal({ root })).toHaveLength(5);

    reconcile(T0 + 10_000, 1000);

    expect(listSkillOperationJournal({ root })).toHaveLength(0);
    expect(existsSync(root)).toBe(true);
    expect(receiptBytes.length).toBeGreaterThan(0);
    // The receipt on disk is untouched by journal retention.
    expect(readFileSync(join(worktreeDir, '.agents', 'skills', SKILL_ID, SKILL_RECEIPT_FILENAME)).length).toBe(
      receiptBytes.length
    );
  });
});
