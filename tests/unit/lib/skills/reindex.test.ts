/**
 * Issue #1248: rebuilding the installed-Skill index from receipts.
 *
 * The acceptance criterion is a round trip: destroy the index, rebuild it from
 * disk, and get back rows whose root set equals what the receipt records. Since
 * #1460 that set has two entries, so a rebuild that only looked at the primary
 * root — or that re-derived the roots from the current default instead of from
 * the receipt — would restore a row that quietly disowns the `.claude/skills`
 * copy.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  SKILL_RECEIPT_FILENAME,
  receiptInstallRoots,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSha256Hex } from '@/lib/skills/integrity';
import {
  getSkillInstallation,
  listSkillInstallations,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import {
  SKILL_REINDEX_OPERATION_ID,
  SkillReindexSkipReason,
  reindexSkillInstallations,
  restoreSkillInstallationIndex,
} from '@/lib/skills/reindex';
import type { SkillInstallReceipt } from '@/types/skills';
import { removeTempDir } from '@tests/helpers/temp-dir';

let db: Database.Database;
let repoRoot: string;

const T0 = 1_800_000_000_000;
const PRIMARY = '.agents/skills';
const SECONDARY = '.claude/skills';

function makeReceipt(
  skillId: string,
  version: string,
  roots: readonly string[]
): SkillInstallReceipt {
  const installRoots = roots.map((prefix) => `${prefix}/${skillId}`);
  return {
    schema_version: 1,
    skill_id: skillId,
    version,
    install_root: installRoots[0],
    ...(installRoots.length > 1 ? { install_roots: installRoots } : {}),
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: `${skillId}-v${version}`,
      commit: 'b'.repeat(40),
    },
    artifact: {
      asset_name: `${skillId}-${version}.tar.gz`,
      sha256: 'c'.repeat(64),
      size: 2048,
      format: 'tar.gz',
    },
    files: [
      { path: 'SKILL.md', sha256: computeSha256Hex(Buffer.from('# demo\n')), size: 7, executable: false },
    ],
    declared_risk: 'low',
    computed_risk: 'moderate',
    effective_risk: 'moderate',
    declared_permissions: [],
    agent_compatibility: [],
  };
}

function insertWorktree(id: string, wtPath: string): void {
  mkdirSync(wtPath, { recursive: true });
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, wtPath, repoRoot);
}

function writePayload(
  wtPath: string,
  receipt: SkillInstallReceipt,
  prefixes: readonly string[]
): void {
  for (const prefix of prefixes) {
    const dir = path.join(wtPath, prefix, receipt.skill_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n');
    writeFileSync(
      path.join(dir, SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(receipt))
    );
  }
}

function install(
  worktreeId: string,
  wtPath: string,
  skillId: string,
  version = '1.2.3',
  prefixes: readonly string[] = [PRIMARY, SECONDARY]
): SkillInstallReceipt {
  const receipt = makeReceipt(skillId, version, prefixes);
  writePayload(wtPath, receipt, prefixes);
  upsertSkillInstallation(db, {
    worktreeId,
    receipt,
    receiptSha256: computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt))),
    operationId: 'op-original',
    installedAt: T0,
  });
  return receipt;
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'cm-1248-reindex-'));
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
  removeTempDir(repoRoot);
});

describe('rebuilding after the index is lost', () => {
  it('restores the row with the root set the receipt records', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    const receipt = install('wt-1', wt, 'demo-skill');

    db.prepare('DELETE FROM skill_installations').run();
    expect(listSkillInstallations(db, 'wt-1')).toHaveLength(0);

    const result = reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(result.indexed).toBe(1);
    const restored = getSkillInstallation(db, 'wt-1', 'demo-skill');
    expect(restored?.installRoots).toEqual(receiptInstallRoots(receipt));
    expect(restored?.installRoots).toEqual([
      '.agents/skills/demo-skill',
      '.claude/skills/demo-skill',
    ]);
  });

  it('restores the provenance from the receipt, not from a guess', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    const receipt = install('wt-1', wt, 'demo-skill', '4.5.6');

    db.prepare('DELETE FROM skill_installations').run();
    reindexSkillInstallations(db, { now: T0 + 1000 });

    const restored = getSkillInstallation(db, 'wt-1', 'demo-skill');
    expect(restored).toMatchObject({
      version: '4.5.6',
      sourceRepository: receipt.source.repository,
      sourceRef: receipt.source.ref,
      sourceCommit: receipt.source.commit,
      artifactSha256: receipt.artifact.sha256,
      effectiveRisk: 'moderate',
    });
    expect(restored?.receiptSha256).toBe(
      computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt)))
    );
  });

  it('marks a rebuilt row as having no originating operation', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    db.prepare('DELETE FROM skill_installations').run();
    reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')?.operationId).toBe(
      SKILL_REINDEX_OPERATION_ID
    );
  });

  it('restores a pre-#1460 single-root receipt as one root, not two', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'legacy-skill', '1.0.0', [PRIMARY]);

    db.prepare('DELETE FROM skill_installations').run();
    reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(getSkillInstallation(db, 'wt-1', 'legacy-skill')?.installRoots).toEqual([
      '.agents/skills/legacy-skill',
    ]);
  });

  it('indexes a package that only reached the secondary root', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    const receipt = makeReceipt('half-skill', '1.0.0', [PRIMARY, SECONDARY]);
    writePayload(wt, receipt, [SECONDARY]);

    const result = reindexSkillInstallations(db, { now: T0 });

    expect(result.indexed).toBe(1);
    expect(getSkillInstallation(db, 'wt-1', 'half-skill')?.installRoots).toEqual(
      receiptInstallRoots(receipt)
    );
  });

  it('rebuilds every worktree in one pass', () => {
    const wt1 = path.join(repoRoot, 'wt-1');
    const wt2 = path.join(repoRoot, 'wt-2');
    insertWorktree('wt-1', wt1);
    insertWorktree('wt-2', wt2);
    install('wt-1', wt1, 'demo-skill', '1.2.3');
    install('wt-2', wt2, 'demo-skill', '2.0.0');

    db.prepare('DELETE FROM skill_installations').run();
    const result = reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(result.scannedWorktrees).toBe(2);
    expect(result.indexed).toBe(2);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')?.version).toBe('1.2.3');
    expect(getSkillInstallation(db, 'wt-2', 'demo-skill')?.version).toBe('2.0.0');
  });
});

describe('converging an existing index', () => {
  it('preserves when the install first landed', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    reindexSkillInstallations(db, { now: T0 + 90_000 });

    const row = getSkillInstallation(db, 'wt-1', 'demo-skill');
    expect(row?.installedAt).toBe(T0);
    expect(row?.updatedAt).toBe(T0 + 90_000);
  });

  it('keeps the originating operation ID of a row that already had one', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')?.operationId).toBe('op-original');
  });

  it('adopts the version on disk when the row disagrees with the receipt', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3');
    writePayload(wt, makeReceipt('demo-skill', '9.9.9', [PRIMARY, SECONDARY]), [
      PRIMARY,
      SECONDARY,
    ]);

    reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')?.version).toBe('9.9.9');
  });

  it('drops a row whose receipt is gone from every root', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    removeTempDir(path.join(wt, PRIMARY, 'demo-skill'));
    removeTempDir(path.join(wt, SECONDARY, 'demo-skill'));

    const result = reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(result.removed).toBe(1);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).toBeNull();
  });

  it('is idempotent', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    const first = reindexSkillInstallations(db, { now: T0 + 1000 });
    const second = reindexSkillInstallations(db, { now: T0 + 2000 });

    expect(second.indexed).toBe(first.indexed);
    expect(second.removed).toBe(0);
    expect(listSkillInstallations(db, 'wt-1')).toHaveLength(1);
  });
});

describe('directories that are not evidence', () => {
  it('reports a directory with no receipt instead of indexing it', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    mkdirSync(path.join(wt, PRIMARY, 'bare-skill'), { recursive: true });
    writeFileSync(path.join(wt, PRIMARY, 'bare-skill', 'SKILL.md'), '# hand written\n');

    const result = reindexSkillInstallations(db, { now: T0 });

    expect(result.indexed).toBe(0);
    expect(result.skipped).toEqual([
      {
        worktreeId: 'wt-1',
        skillId: 'bare-skill',
        root: '.agents/skills/bare-skill',
        reason: SkillReindexSkipReason.RECEIPT_MISSING,
      },
    ]);
  });

  it('reports an unparseable receipt', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    mkdirSync(path.join(wt, PRIMARY, 'broken-skill'), { recursive: true });
    writeFileSync(path.join(wt, PRIMARY, 'broken-skill', SKILL_RECEIPT_FILENAME), '{ not json');

    const result = reindexSkillInstallations(db, { now: T0 });

    expect(result.indexed).toBe(0);
    expect(result.skipped[0].reason).toBe(SkillReindexSkipReason.RECEIPT_UNREADABLE);
  });

  it('refuses a receipt written for a different Skill', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    const dir = path.join(wt, PRIMARY, 'wrong-skill');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(makeReceipt('other-skill', '1.0.0', [PRIMARY])))
    );

    const result = reindexSkillInstallations(db, { now: T0 });

    expect(result.indexed).toBe(0);
    expect(result.skipped[0].reason).toBe(SkillReindexSkipReason.RECEIPT_FOREIGN);
    expect(getSkillInstallation(db, 'wt-1', 'wrong-skill')).toBeNull();
  });

  it('ignores the reserved staging directory', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    mkdirSync(path.join(wt, PRIMARY, '.commandmate-staging', 'demo-skill'), { recursive: true });

    const result = reindexSkillInstallations(db, { now: T0 });

    expect(result.indexed).toBe(0);
    expect(result.skipped).toHaveLength(0);
  });

  it('leaves the index alone for a worktree whose directory is gone', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    removeTempDir(wt);

    const result = reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(result.unreadableWorktreeIds).toEqual(['wt-1']);
    expect(result.removed).toBe(0);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).not.toBeNull();
  });
});

describe('restoring one worktree from a read (#1709)', () => {
  /**
   * The per-worktree entry a list request can afford to take. It differs from
   * the full rebuild in exactly two ways — it fills gaps only, and it prunes
   * nothing — and both differences are what make it safe to run on a read.
   */
  it('restores a receipt the index never had', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    const receipt = install('wt-1', wt, 'demo-skill');
    db.prepare('DELETE FROM skill_installations').run();

    const result = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 1000 });

    expect(result.indexed).toBe(1);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')?.installRoots).toEqual(
      receiptInstallRoots(receipt)
    );
  });

  it('reads only the worktree it was given', () => {
    const wt1 = path.join(repoRoot, 'wt-1');
    const wt2 = path.join(repoRoot, 'wt-2');
    insertWorktree('wt-1', wt1);
    insertWorktree('wt-2', wt2);
    install('wt-1', wt1, 'demo-skill');
    install('wt-2', wt2, 'demo-skill');
    db.prepare('DELETE FROM skill_installations').run();

    const result = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt1 }, { now: T0 });

    expect(result.indexed).toBe(1);
    expect(listSkillInstallations(db, 'wt-2')).toHaveLength(0);
  });

  it('leaves a row the index already has exactly as it was', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3');
    // Disk disagrees; converging it is the explicit rebuild's job, not a read's.
    writePayload(wt, makeReceipt('demo-skill', '9.9.9', [PRIMARY, SECONDARY]), [
      PRIMARY,
      SECONDARY,
    ]);

    const result = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 90_000 });

    expect(result.indexed).toBe(0);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).toMatchObject({
      version: '1.2.3',
      operationId: 'op-original',
      installedAt: T0,
      updatedAt: T0,
    });
  });

  it('never drops a row whose payload is gone', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    removeTempDir(path.join(wt, PRIMARY, 'demo-skill'));
    removeTempDir(path.join(wt, SECONDARY, 'demo-skill'));

    restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 1000 });

    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).not.toBeNull();
  });

  it('reports a directory that is not evidence instead of indexing it', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    mkdirSync(path.join(wt, PRIMARY, 'bare-skill'), { recursive: true });
    writeFileSync(path.join(wt, PRIMARY, 'bare-skill', 'SKILL.md'), '# hand written\n');

    const result = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 });

    expect(result.indexed).toBe(0);
    expect(result.skipped).toEqual([
      {
        worktreeId: 'wt-1',
        skillId: 'bare-skill',
        root: '.agents/skills/bare-skill',
        reason: SkillReindexSkipReason.RECEIPT_MISSING,
      },
    ]);
  });

  it('concludes nothing from a worktree directory that is gone', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    removeTempDir(wt);

    const result = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 1000 });

    expect(result.indexed).toBe(0);
    expect(getSkillInstallation(db, 'wt-1', 'demo-skill')).not.toBeNull();
  });

  it('is idempotent', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    db.prepare('DELETE FROM skill_installations').run();

    const first = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 1000 });
    const second = restoreSkillInstallationIndex(db, { id: 'wt-1', path: wt }, { now: T0 + 2000 });

    expect(first.indexed).toBe(1);
    expect(second.indexed).toBe(0);
    expect(listSkillInstallations(db, 'wt-1')).toHaveLength(1);
  });
});

describe('the receipt on disk stays the source of truth', () => {
  it('leaves every byte under the install roots untouched', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    const digestTree = (): string[] =>
      [PRIMARY, SECONDARY].flatMap((prefix) => {
        const dir = path.join(wt, prefix, 'demo-skill');
        return readdirSync(dir)
          .sort()
          .map((name) => `${prefix}/${name}:${computeSha256Hex(readFileSync(path.join(dir, name)))}`);
      });

    const before = digestTree();
    reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(digestTree()).toEqual(before);
    expect(before.some((line) => line.includes(SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('never appends to the append-only operation log', () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    reindexSkillInstallations(db, { now: T0 + 1000 });

    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
