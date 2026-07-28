/**
 * Issue #1248: cross-worktree applied-state scan.
 *
 * The property that matters is that the scan believes the disk over the index,
 * and that it looks at *every* root the receipt names. Since #1460 an install
 * lands in `.agents/skills` and `.claude/skills`; a scan that only read the
 * primary would call a half-deleted install healthy, which is the failure this
 * screen exists to prevent. Each drift case below is therefore injected into the
 * secondary root as well as the primary.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertSkillInstallation } from '@/lib/skills/installed-state';
import {
  SKILL_RECEIPT_FILENAME,
  buildSkillInstallReceipt,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSha256Hex } from '@/lib/skills/integrity';
import {
  invalidateSkillStatusScanCache,
  scanSkillInstallationStatus,
} from '@/lib/skills/status-scanner';
import type { SkillInstallReceipt } from '@/types/skills';

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
    files: [{ path: 'SKILL.md', sha256: computeSha256Hex(Buffer.from('# demo\n')), size: 7, executable: false }],
    declared_risk: 'low',
    computed_risk: 'low',
    effective_risk: 'low',
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

/** Write the payload for one Skill into the given root prefixes. */
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

/** Install a Skill on disk and in the index, the way a real install leaves it. */
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
    operationId: 'op-1',
    installedAt: T0,
  });
  return receipt;
}

async function scan(latestVersions?: Map<string, string>) {
  return scanSkillInstallationStatus(db, { refresh: true, now: T0, latestVersions });
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'cm-1248-scan-'));
  db = new Database(':memory:');
  runMigrations(db);
  invalidateSkillStatusScanCache();
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  invalidateSkillStatusScanCache();
});

describe('a clean multi-root install', () => {
  it('reports installed and names every recorded root', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    const result = await scan();

    expect(result.entries).toHaveLength(1);
    const [entry] = result.entries;
    expect(entry.status).toBe('installed');
    expect(entry.version).toBe('1.2.3');
    expect(entry.installRoots.map((r) => r.root)).toEqual([
      '.agents/skills/demo-skill',
      '.claude/skills/demo-skill',
    ]);
    expect(entry.installRoots.every((r) => r.present)).toBe(true);
  });

  it('reads a pre-#1460 single-root receipt as the one root it names', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3', [PRIMARY]);

    const [entry] = (await scan()).entries;

    expect(entry.installRoots.map((r) => r.root)).toEqual(['.agents/skills/demo-skill']);
    expect(entry.status).toBe('installed');
  });
});

describe('drift in the secondary root', () => {
  it('reports missing when only the .claude payload is deleted', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    rmSync(path.join(wt, SECONDARY, 'demo-skill'), { recursive: true, force: true });

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('missing');
    expect(entry.installRoots.find((r) => r.rootPrefix === PRIMARY)?.present).toBe(true);
    expect(entry.installRoots.find((r) => r.rootPrefix === SECONDARY)?.present).toBe(false);
  });

  it('reports modified when only the .claude payload is edited', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    writeFileSync(path.join(wt, SECONDARY, 'demo-skill', 'SKILL.md'), '# tampered\n');

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('modified');
    expect(entry.installRoots.find((r) => r.rootPrefix === SECONDARY)?.modifiedFiles).toBe(1);
    expect(entry.installRoots.find((r) => r.rootPrefix === PRIMARY)?.modifiedFiles).toBe(0);
  });

  it('counts a stray file in the secondary root as unmanaged drift', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    writeFileSync(path.join(wt, SECONDARY, 'demo-skill', 'extra.txt'), 'stray\n');

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('modified');
    expect(entry.installRoots.find((r) => r.rootPrefix === SECONDARY)?.unmanagedFiles).toBe(1);
  });

  it('reports a symlink under a root as irregular rather than following it', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    symlinkSync('/etc/passwd', path.join(wt, SECONDARY, 'demo-skill', 'link'));

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('modified');
    expect(entry.installRoots.find((r) => r.rootPrefix === SECONDARY)?.irregularPaths).toBe(1);
  });

  it('drops the receipt digest for a root whose receipt was deleted', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    rmSync(path.join(wt, SECONDARY, 'demo-skill', SKILL_RECEIPT_FILENAME));

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('modified');
    const secondary = entry.installRoots.find((r) => r.rootPrefix === SECONDARY);
    expect(secondary?.receiptSha256).toBeNull();
    expect(secondary?.unmanagedFiles).toBeGreaterThan(0);
  });
});

describe('payload with no index row', () => {
  it('reports unmanaged and carries the version from the receipt', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    writePayload(wt, makeReceipt('orphan-skill', '2.0.0', [PRIMARY, SECONDARY]), [
      PRIMARY,
      SECONDARY,
    ]);

    const [entry] = (await scan()).entries;

    expect(entry.status).toBe('unmanaged');
    expect(entry.skillId).toBe('orphan-skill');
    expect(entry.version).toBe('2.0.0');
    expect(entry.installedAt).toBeNull();
    expect(entry.source).toBeNull();
  });

  it('ignores the reserved staging directory', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    mkdirSync(path.join(wt, PRIMARY, '.commandmate-staging', 'whatever'), { recursive: true });

    expect((await scan()).entries).toHaveLength(0);
  });
});

describe('available updates', () => {
  it('reports update_available only for a clean install', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3');

    const [entry] = (await scan(new Map([['demo-skill', '2.0.0']]))).entries;

    expect(entry.status).toBe('update_available');
    expect(entry.latestVersion).toBe('2.0.0');
  });

  it('keeps drift ahead of an available update', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3');
    writeFileSync(path.join(wt, PRIMARY, 'demo-skill', 'SKILL.md'), '# tampered\n');

    const [entry] = (await scan(new Map([['demo-skill', '2.0.0']]))).entries;

    expect(entry.status).toBe('modified');
  });

  it('stays installed when the catalog is not newer', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill', '1.2.3');

    const [entry] = (await scan(new Map([['demo-skill', '1.2.3']]))).entries;

    expect(entry.status).toBe('installed');
  });
});

describe('across worktrees', () => {
  it('reports every registered worktree in one scan', async () => {
    const wt1 = path.join(repoRoot, 'wt-1');
    const wt2 = path.join(repoRoot, 'wt-2');
    insertWorktree('wt-1', wt1);
    insertWorktree('wt-2', wt2);
    install('wt-1', wt1, 'demo-skill', '1.2.3');
    install('wt-2', wt2, 'demo-skill', '1.0.0');

    const result = await scan();

    expect(result.worktreeCount).toBe(2);
    expect(
      result.entries.map((e) => `${e.worktreeId}:${e.version}`).sort()
    ).toEqual(['wt-1:1.2.3', 'wt-2:1.0.0']);
  });

  it('names a worktree whose directory is gone instead of blaming its Skills', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');
    rmSync(wt, { recursive: true, force: true });

    const result = await scan();

    expect(result.unreadableWorktreeIds).toEqual(['wt-1']);
    expect(result.entries).toHaveLength(0);
  });
});

describe('caching', () => {
  it('serves a repeat read without re-walking the disk', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    const first = await scanSkillInstallationStatus(db, { now: T0 });
    rmSync(path.join(wt, SECONDARY, 'demo-skill'), { recursive: true, force: true });
    const second = await scanSkillInstallationStatus(db, { now: T0 + 1 });

    expect(second).toBe(first);
    expect(second.entries[0].status).toBe('installed');
  });

  it('re-walks once the cache is invalidated', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    await scanSkillInstallationStatus(db, { now: T0 });
    rmSync(path.join(wt, SECONDARY, 'demo-skill'), { recursive: true, force: true });
    invalidateSkillStatusScanCache();
    const fresh = await scanSkillInstallationStatus(db, { now: T0 + 1 });

    expect(fresh.entries[0].status).toBe('missing');
  });

  it('re-walks after the TTL expires', async () => {
    const wt = path.join(repoRoot, 'wt-1');
    insertWorktree('wt-1', wt);
    install('wt-1', wt, 'demo-skill');

    await scanSkillInstallationStatus(db, { now: T0 });
    rmSync(path.join(wt, SECONDARY, 'demo-skill'), { recursive: true, force: true });
    const later = await scanSkillInstallationStatus(db, { now: T0 + 60_000 });

    expect(later.entries[0].status).toBe('missing');
  });
});
