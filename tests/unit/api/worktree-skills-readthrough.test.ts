/**
 * Issue #1709: the installed-Skill list route reads *through* its index.
 *
 * The defect this pins down is not a missing feature but a category error: the
 * index (#1235) is a per-database cache over receipts that live inside the
 * worktree, and the list route read it as if it were the truth. Install a Skill
 * from one instance, list it from another — different `CM_DB_PATH`, same disk —
 * and the payload and receipt are both right there while the response says
 * `{"skills":[]}`. "Not installed" and "not indexed" were indistinguishable.
 *
 * So the assertions here are deliberately about the *disk*, not about a helper:
 * a real temp worktree with real receipt bytes, an in-memory database whose
 * `skill_installations` table is genuinely empty, and the route itself. The
 * second-read tests delete the receipts afterwards, so a response that still
 * lists the Skill can only have come from the restored index — which is what
 * "read-through cache" has to mean to be worth anything.
 *
 * Issue #1753 is the same category error one step in: a row that *exists* and
 * is stale. #1709 fixed "not indexed" being read as "not installed" but left
 * "indexed at the wrong version" being read as the installed version, so the
 * list route and the update route — which reads the receipt — answered
 * differently inside one server, and the update the screen offered could never
 * apply. A read converges the row now. It still does not prune one.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
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
import { SKILL_REINDEX_OPERATION_ID } from '@/lib/skills/reindex';
import { hasSkillUpdate } from '@/lib/skills/version-resolver';
import type { SkillInstallReceipt } from '@/types/skills';
import type { Worktree } from '@/types/models';
import { removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  })),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn() }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/skills/status-scanner', () => ({
  invalidateSkillStatusScanCache: vi.fn(),
}));

import { GET } from '@/app/api/worktrees/[id]/skills/route';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { invalidateSkillStatusScanCache } from '@/lib/skills/status-scanner';

const getDbInstanceMock = vi.mocked(getDbInstance);
const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const invalidateCacheMock = vi.mocked(invalidateSkillStatusScanCache);

const T0 = 1_800_000_000_000;
const WORKTREE_ID = 'demo-wt';
const PRIMARY = '.agents/skills';
const SECONDARY = '.claude/skills';

let db: Database.Database;
let repoRoot: string;
let worktreePath: string;

function makeReceipt(
  skillId = 'demo-skill',
  version = '1.2.3',
  prefixes: readonly string[] = [PRIMARY, SECONDARY]
): SkillInstallReceipt {
  const installRoots = prefixes.map((prefix) => `${prefix}/${skillId}`);
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

/** Write the payload and receipt a real install leaves behind, and nothing else. */
function writePayload(
  receipt: SkillInstallReceipt,
  prefixes: readonly string[] = receiptInstallRoots(receipt).map((root) => path.dirname(root))
): void {
  for (const prefix of prefixes) {
    const dir = path.join(worktreePath, prefix, receipt.skill_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n');
    writeFileSync(
      path.join(dir, SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(receipt))
    );
  }
}

/** A directory that looks like an install but carries no receipt. */
function writeBarePayload(skillId: string, prefix = PRIMARY): void {
  const dir = path.join(worktreePath, prefix, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, 'SKILL.md'), '# hand written\n');
}

function writeReceiptBytes(skillId: string, bytes: string | Uint8Array, prefix = PRIMARY): void {
  const dir = path.join(worktreePath, prefix, skillId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, SKILL_RECEIPT_FILENAME), bytes);
}

function removePayload(skillId: string): void {
  for (const prefix of [PRIMARY, SECONDARY]) {
    removeTempDir(path.join(worktreePath, prefix, skillId));
  }
}

/** Index a Skill the way an install on *this* instance would have. */
function indexInstall(receipt: SkillInstallReceipt, operationId = 'op-original'): void {
  upsertSkillInstallation(db, {
    worktreeId: WORKTREE_ID,
    receipt,
    receiptSha256: computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt))),
    operationId,
    installedAt: T0,
  });
}

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'feature/demo',
    path: worktreePath,
    repositoryPath: repoRoot,
    repositoryName: 'repo',
    branch: 'feature/demo',
  };
}

function callRaw(id: string = WORKTREE_ID) {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${id}/skills`);
  return GET(request, { params: Promise.resolve({ id }) });
}

async function call(id: string = WORKTREE_ID) {
  const response = await callRaw(id);
  return { response, body: await response.json() };
}

function skillIds(body: { skills: { skillId: string }[] }): string[] {
  return body.skills.map((skill) => skill.skillId);
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'cm-1709-readthrough-'));
  worktreePath = path.join(repoRoot, WORKTREE_ID);
  mkdirSync(worktreePath, { recursive: true });

  db = new Database(':memory:');
  runMigrations(db);
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, ?, 'repo')`
  ).run(WORKTREE_ID, WORKTREE_ID, worktreePath, repoRoot);

  vi.clearAllMocks();
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());
});

afterEach(() => {
  db.close();
  removeTempDir(repoRoot);
});

describe('GET /api/worktrees/[id]/skills — an index another instance never wrote', () => {
  it('lists a Skill whose receipt is on disk while the index is empty', async () => {
    const receipt = makeReceipt();
    writePayload(receipt);
    expect(listSkillInstallations(db, WORKTREE_ID)).toHaveLength(0);

    const { response, body } = await call();

    expect(response.status).toBe(200);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toMatchObject({
      skillId: 'demo-skill',
      version: '1.2.3',
      installRoot: '.agents/skills/demo-skill',
      artifactSha256: receipt.artifact.sha256,
      effectiveRisk: 'moderate',
      source: {
        repository: receipt.source.repository,
        ref: receipt.source.ref,
        commit: receipt.source.commit,
      },
    });
    expect(body.skills[0].receiptSha256).toBe(
      computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt)))
    );
  });

  it('restores the index row, so the next read is served from it', async () => {
    writePayload(makeReceipt());

    await call();

    const restored = getSkillInstallation(db, WORKTREE_ID, 'demo-skill');
    expect(restored).not.toBeNull();
    expect(restored?.operationId).toBe(SKILL_REINDEX_OPERATION_ID);

    // Only the index can answer once the receipts are gone from disk.
    removePayload('demo-skill');
    const second = await call();
    expect(skillIds(second.body)).toEqual(['demo-skill']);
  });

  it('restores the root set the receipt records, not the current default', async () => {
    writePayload(makeReceipt('legacy-skill', '1.0.0', [PRIMARY]));

    await call();

    expect(getSkillInstallation(db, WORKTREE_ID, 'legacy-skill')?.installRoots).toEqual([
      '.agents/skills/legacy-skill',
    ]);
  });

  it('treats a Skill in both roots as one install with both roots recorded', async () => {
    const receipt = makeReceipt();
    writePayload(receipt);

    const { body } = await call();

    expect(skillIds(body)).toEqual(['demo-skill']);
    expect(getSkillInstallation(db, WORKTREE_ID, 'demo-skill')?.installRoots).toEqual(
      receiptInstallRoots(receipt)
    );
  });

  it('indexes a package that only reached the secondary root', async () => {
    writePayload(makeReceipt('half-skill'), [SECONDARY]);

    const { body } = await call();

    expect(skillIds(body)).toEqual(['half-skill']);
  });

  it('fills only the gap when the index is partially populated', async () => {
    const indexed = makeReceipt('indexed-skill');
    const orphan = makeReceipt('orphan-skill');
    writePayload(indexed);
    writePayload(orphan);
    indexInstall(indexed);

    const { body } = await call();

    expect(skillIds(body)).toEqual(['indexed-skill', 'orphan-skill']);
    // The row that was already correct keeps its originating operation.
    expect(getSkillInstallation(db, WORKTREE_ID, 'indexed-skill')?.operationId).toBe('op-original');
    expect(getSkillInstallation(db, WORKTREE_ID, 'orphan-skill')?.operationId).toBe(
      SKILL_REINDEX_OPERATION_ID
    );
  });

  it('invalidates the dashboard scan cache only when it restored something', async () => {
    writePayload(makeReceipt());

    await call();
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);

    // Second read finds no gap, so nothing changed and nothing is invalidated.
    await call();
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
  });
});

describe('GET /api/worktrees/[id]/skills — a directory is not evidence', () => {
  it('leaves a payload with no receipt unmanaged', async () => {
    writeBarePayload('bare-skill');

    const { body } = await call();

    expect(body.skills).toEqual([]);
    expect(getSkillInstallation(db, WORKTREE_ID, 'bare-skill')).toBeNull();
  });

  it('leaves a payload with an unparseable receipt unmanaged', async () => {
    writeReceiptBytes('broken-skill', '{ not json');

    const { body } = await call();

    expect(body.skills).toEqual([]);
    expect(getSkillInstallation(db, WORKTREE_ID, 'broken-skill')).toBeNull();
  });

  it('refuses a receipt written for a different Skill', async () => {
    writeReceiptBytes(
      'wrong-skill',
      Buffer.from(serializeSkillInstallReceipt(makeReceipt('other-skill', '1.0.0', [PRIMARY])))
    );

    const { body } = await call();

    expect(body.skills).toEqual([]);
    expect(getSkillInstallation(db, WORKTREE_ID, 'wrong-skill')).toBeNull();
  });

  it('ignores the reserved staging directory', async () => {
    mkdirSync(path.join(worktreePath, PRIMARY, '.commandmate-staging', 'demo-skill'), {
      recursive: true,
    });

    const { body } = await call();

    expect(body.skills).toEqual([]);
    expect(listSkillInstallations(db, WORKTREE_ID)).toHaveLength(0);
  });

  it('returns an empty list when the worktree directory is gone', async () => {
    removeTempDir(worktreePath);

    const { response, body } = await call();

    expect(response.status).toBe(200);
    expect(body.skills).toEqual([]);
  });
});

describe('GET /api/worktrees/[id]/skills — the indexed answer does not regress', () => {
  it('serves the indexed row unchanged when nothing is missing', async () => {
    const receipt = makeReceipt();
    writePayload(receipt);
    indexInstall(receipt, 'op-1');

    const { response, body } = await call();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      worktreeId: WORKTREE_ID,
      skills: [
        {
          skillId: 'demo-skill',
          version: '1.2.3',
          installRoot: '.agents/skills/demo-skill',
          receiptSha256: computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt))),
          artifactSha256: receipt.artifact.sha256,
          source: {
            repository: receipt.source.repository,
            ref: receipt.source.ref,
            commit: receipt.source.commit,
          },
          effectiveRisk: 'moderate',
          installedAt: T0,
          updatedAt: T0,
        },
      ],
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('does not re-date or re-attribute a row the index already has', async () => {
    const receipt = makeReceipt();
    writePayload(receipt);
    indexInstall(receipt, 'op-1');

    await call();

    expect(getSkillInstallation(db, WORKTREE_ID, 'demo-skill')).toMatchObject({
      operationId: 'op-1',
      installedAt: T0,
      updatedAt: T0,
    });
  });

  /**
   * #1709 pinned the opposite of this: the indexed version was served and the
   * receipt was ignored, because converging a row was held to be the explicit
   * rebuild's job. #1753 is the bill for that. The stale row is what the screen
   * shows, so it is also what the client offers to update from — and the update
   * route reads the receipt, sees the "new" version already installed, and
   * rejects the request as not strictly newer. The user reads that as "already
   * up to date" while looking at an update button. A read converges now, so
   * both routes answer from the same evidence.
   */
  it('serves the version on disk when the receipt disagrees with the index', async () => {
    indexInstall(makeReceipt('demo-skill', '1.2.3'));
    writePayload(makeReceipt('demo-skill', '9.9.9'));

    const { body } = await call();

    expect(body.skills[0].version).toBe('9.9.9');
    // And the row itself converged, so the next read needs no repair at all.
    expect(getSkillInstallation(db, WORKTREE_ID, 'demo-skill')?.version).toBe('9.9.9');
  });

  it('invalidates the dashboard scan cache when it converges a drifted row', async () => {
    indexInstall(makeReceipt('demo-skill', '1.2.3'));
    writePayload(makeReceipt('demo-skill', '9.9.9'));

    await call();
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);

    // Second read finds nothing to converge, so nothing is invalidated again.
    await call();
    expect(invalidateCacheMock).toHaveBeenCalledTimes(1);
  });

  /**
   * The reported state, with the versions it was reported with: `cmate-verify`
   * indexed at 0.3.1 while the receipt on disk — and the Catalog — said 0.4.2.
   * The screen offered an update to a version that was already installed, and
   * the update route rejected it. `hasSkillUpdate` is the predicate the pane
   * badges on, so running it over the served version is what says the affordance
   * is gone, not merely that the number changed.
   */
  it('offers no update once the served version is the one on disk', async () => {
    indexInstall(makeReceipt('cmate-verify', '0.3.1'));
    writePayload(makeReceipt('cmate-verify', '0.4.2'));

    const { body } = await call();

    expect(body.skills[0].version).toBe('0.4.2');
    expect(hasSkillUpdate(body.skills[0].version, '0.4.2')).toBe(false);
  });

  it('keeps serving the indexed row when the receipt agrees with it', async () => {
    const receipt = makeReceipt('demo-skill', '1.2.3');
    indexInstall(receipt);
    writePayload(receipt);

    const { body } = await call();

    expect(body.skills[0]).toMatchObject({ version: '1.2.3', installedAt: T0, updatedAt: T0 });
    expect(invalidateCacheMock).not.toHaveBeenCalled();
  });

  it('never deletes an index row whose payload is absent', async () => {
    indexInstall(makeReceipt());

    const { body } = await call();

    expect(skillIds(body)).toEqual(['demo-skill']);
    expect(getSkillInstallation(db, WORKTREE_ID, 'demo-skill')).not.toBeNull();
  });

  it('scopes the restore to the requested worktree', async () => {
    const other = path.join(repoRoot, 'other-wt');
    mkdirSync(path.join(other, PRIMARY, 'other-skill'), { recursive: true });
    db.prepare(
      `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
       VALUES ('other-wt', 'other-wt', ?, ?, 'repo')`
    ).run(other, repoRoot);
    writeFileSync(
      path.join(other, PRIMARY, 'other-skill', SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(makeReceipt('other-skill', '1.0.0', [PRIMARY])))
    );
    writePayload(makeReceipt());

    const { body } = await call();

    expect(skillIds(body)).toEqual(['demo-skill']);
    expect(listSkillInstallations(db, 'other-wt')).toHaveLength(0);
  });
});

describe('GET /api/worktrees/[id]/skills — restoring stays a read', () => {
  it('leaves every byte under the install roots untouched', async () => {
    writePayload(makeReceipt());

    const digestTree = (): string[] =>
      [PRIMARY, SECONDARY].flatMap((prefix) => {
        const dir = path.join(worktreePath, prefix, 'demo-skill');
        return readdirSync(dir)
          .sort()
          .map(
            (name) => `${prefix}/${name}:${computeSha256Hex(readFileSync(path.join(dir, name)))}`
          );
      });

    const before = digestTree();
    await call();

    expect(digestTree()).toEqual(before);
    expect(before.some((line) => line.includes(SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('never appends to the append-only operation log', async () => {
    writePayload(makeReceipt());

    await call();

    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(0);
  });

  it('leaks no absolute path into the restored response', async () => {
    writePayload(makeReceipt());

    const text = await (await callRaw()).text();

    expect(text).not.toContain(worktreePath);
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
  });
});
