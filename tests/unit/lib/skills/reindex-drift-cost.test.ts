/**
 * Issue #1753: what a converging read is allowed to cost.
 *
 * Making a read converge the index means the receipt of every installed Skill
 * is opened on every list request — that is the price of noticing that a row is
 * stale, and #1709 avoided it by never opening the receipt of a Skill the index
 * already had. What that bought was a cache that could not tell a correct row
 * from a wrong one.
 *
 * So the bill is paid deliberately and bounded deliberately: read the bytes,
 * hash them, and compare with the digest the row already recorded. A row that
 * matches costs one read and one hash — no parse, no write, no re-dating, no
 * scan-cache invalidation. The assertions here are call counts rather than
 * outcomes, because "the row did not change" is also true of a write that wrote
 * the same values back, and it is the write that has to not happen.
 *
 * The digest is the receipt's whole bytes, not its version field, so republished
 * bytes with the same version are drift too. That is checked in `reindex.test.ts`;
 * what is checked here is that noticing it costs nothing when there is nothing
 * to notice.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { computeSha256Hex } from '@/lib/skills/integrity';
import type { SkillInstallReceipt } from '@/types/skills';
import { removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/skills/install-plan', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/install-plan')>();
  return { ...actual, parseInstalledReceipt: vi.fn(actual.parseInstalledReceipt) };
});

vi.mock('@/lib/skills/installed-state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/installed-state')>();
  return { ...actual, upsertSkillInstallation: vi.fn(actual.upsertSkillInstallation) };
});

import {
  SKILL_RECEIPT_FILENAME,
  parseInstalledReceipt,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import {
  deleteSkillInstallation,
  upsertSkillInstallation,
} from '@/lib/skills/installed-state';
import {
  reindexSkillInstallations,
  restoreSkillInstallationIndex,
} from '@/lib/skills/reindex';

const parseMock = vi.mocked(parseInstalledReceipt);
const upsertMock = vi.mocked(upsertSkillInstallation);

const T0 = 1_800_000_000_000;
const PRIMARY = '.agents/skills';
const SECONDARY = '.claude/skills';
const SKILL_IDS = ['alpha-skill', 'beta-skill', 'gamma-skill'];

let db: Database.Database;
let repoRoot: string;
let worktreePath: string;

function makeReceipt(skillId: string, version: string): SkillInstallReceipt {
  const installRoots = [PRIMARY, SECONDARY].map((prefix) => `${prefix}/${skillId}`);
  return {
    schema_version: 1,
    skill_id: skillId,
    version,
    install_root: installRoots[0],
    install_roots: installRoots,
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
      {
        path: 'SKILL.md',
        sha256: computeSha256Hex(Buffer.from('# demo\n')),
        size: 7,
        executable: false,
      },
    ],
    declared_risk: 'low',
    computed_risk: 'moderate',
    effective_risk: 'moderate',
    declared_permissions: [],
    agent_compatibility: [],
  };
}

/** Write the payload of a real install into both roots. */
function writePayload(receipt: SkillInstallReceipt): void {
  for (const prefix of [PRIMARY, SECONDARY]) {
    const dir = path.join(worktreePath, prefix, receipt.skill_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n');
    writeFileSync(
      path.join(dir, SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(receipt))
    );
  }
}

/** Payload on disk plus the index row an install on this instance would write. */
function install(skillId: string, version = '1.2.3'): void {
  const receipt = makeReceipt(skillId, version);
  writePayload(receipt);
  upsertSkillInstallation(db, {
    worktreeId: 'wt-1',
    receipt,
    receiptSha256: computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt))),
    operationId: 'op-original',
    installedAt: T0,
  });
}

function restore() {
  return restoreSkillInstallationIndex(db, { id: 'wt-1', path: worktreePath }, { now: T0 + 1000 });
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'cm-1753-cost-'));
  worktreePath = path.join(repoRoot, 'wt-1');
  mkdirSync(worktreePath, { recursive: true });

  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES ('wt-1', 'wt-1', ?, ?, 'repo')`
  ).run(worktreePath, repoRoot);

  for (const skillId of SKILL_IDS) install(skillId);
  vi.clearAllMocks();
});

afterEach(() => {
  db.close();
  removeTempDir(repoRoot);
});

describe('a converging read pays nothing for the rows that agree', () => {
  it('neither parses nor writes a receipt whose digest matches the row', () => {
    const result = restore();

    expect(result).toMatchObject({ indexed: 0, converged: 0 });
    expect(parseMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('stays free however many times it is called', () => {
    restore();
    restore();
    restore();

    expect(parseMock).not.toHaveBeenCalled();
    expect(upsertMock).not.toHaveBeenCalled();
  });

  it('parses and writes exactly the one row that drifted', () => {
    writePayload(makeReceipt('beta-skill', '9.9.9'));

    const result = restore();

    expect(result).toMatchObject({ indexed: 1, converged: 1 });
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][1]).toMatchObject({
      worktreeId: 'wt-1',
      receipt: { skill_id: 'beta-skill', version: '9.9.9' },
    });
  });

  it('parses and writes exactly the one row that is missing', () => {
    deleteSkillInstallation(db, 'wt-1', 'gamma-skill');
    vi.clearAllMocks();

    const result = restore();

    expect(result).toMatchObject({ indexed: 1, converged: 0 });
    expect(parseMock).toHaveBeenCalledTimes(1);
    expect(upsertMock).toHaveBeenCalledTimes(1);
    expect(upsertMock.mock.calls[0][1]).toMatchObject({
      receipt: { skill_id: 'gamma-skill' },
    });
  });

  it('reads a Skill present in both roots once, not once per root', () => {
    writePayload(makeReceipt('beta-skill', '9.9.9'));

    restore();

    // The primary root settles the Skill; the secondary copy is never opened.
    expect(parseMock).toHaveBeenCalledTimes(1);
  });
});

describe('the explicit rebuild is still a rebuild', () => {
  it('rewrites every row rather than trusting the digest it is rebuilding', () => {
    const result = reindexSkillInstallations(db, { now: T0 + 1000 });

    expect(result.indexed).toBe(SKILL_IDS.length);
    expect(parseMock).toHaveBeenCalledTimes(SKILL_IDS.length);
    expect(upsertMock).toHaveBeenCalledTimes(SKILL_IDS.length);
  });
});
