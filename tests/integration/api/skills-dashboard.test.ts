/**
 * API integration tests — Skill applied-state dashboard routes (Issue #1248)
 *
 * Three routes, one screen: the cross-worktree status scan, the operation log
 * feed, and the index rebuild. What is under test is the wiring a unit test
 * cannot reach — that filters actually narrow, that bad filter values are
 * refused rather than silently ignored, that an unreachable Catalog degrades to
 * "updates unknown" instead of a failed request, and that a rebuild is visible
 * to the very next scan rather than hidden behind the scan cache.
 *
 * A real temporary worktree tree and a fresh in-memory database back the routes,
 * so the receipt walk under test is the real one. Nothing touches the network or
 * the production database.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertSkillInstallation } from '@/lib/skills/installed-state';
import {
  SKILL_RECEIPT_FILENAME,
  serializeSkillInstallReceipt,
} from '@/lib/skills/install-plan';
import { computeSha256Hex } from '@/lib/skills/integrity';
import { recordSkillOperationAudit } from '@/lib/skills/operation-audit';
import type { SkillOperationAuditInput } from '@/lib/skills/operation-audit';
import { invalidateSkillStatusScanCache } from '@/lib/skills/status-scanner';
import type { SkillInstallReceipt } from '@/types/skills';

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
vi.mock('@/lib/skills/catalog-client', () => ({ getSkillCatalog: vi.fn() }));

import { GET as getInstallations } from '@/app/api/skills/installations/route';
import { GET as getOperations } from '@/app/api/skills/operations/route';
import { POST as postReindex } from '@/app/api/skills/reindex/route';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import type { SkillInstallationsResponse } from '@/app/api/skills/installations/route';
import type { SkillOperationsResponse } from '@/app/api/skills/operations/route';
import type { SkillReindexResponse } from '@/app/api/skills/reindex/route';

const getDbInstanceMock = vi.mocked(getDbInstance);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);

const T0 = 1_800_000_000_000;
const PRIMARY = '.agents/skills';
const SECONDARY = '.claude/skills';

let db: Database.Database;
let repoRoot: string;

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
    computed_risk: 'low',
    effective_risk: 'low',
    declared_permissions: [],
    agent_compatibility: [],
  };
}

function insertWorktree(id: string): string {
  const wtPath = path.join(repoRoot, id);
  mkdirSync(wtPath, { recursive: true });
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, ?, 'repo')`
  ).run(id, id, wtPath, repoRoot);
  return wtPath;
}

function writePayload(wtPath: string, receipt: SkillInstallReceipt): void {
  for (const prefix of [PRIMARY, SECONDARY]) {
    const dir = path.join(wtPath, prefix, receipt.skill_id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, 'SKILL.md'), '# demo\n');
    writeFileSync(
      path.join(dir, SKILL_RECEIPT_FILENAME),
      Buffer.from(serializeSkillInstallReceipt(receipt))
    );
  }
}

function install(worktreeId: string, wtPath: string, skillId: string, version = '1.2.3'): void {
  const receipt = makeReceipt(skillId, version);
  writePayload(wtPath, receipt);
  upsertSkillInstallation(db, {
    worktreeId,
    receipt,
    receiptSha256: computeSha256Hex(Buffer.from(serializeSkillInstallReceipt(receipt))),
    operationId: 'op-1',
    installedAt: T0,
  });
}

function auditInput(overrides: Partial<SkillOperationAuditInput> = {}): SkillOperationAuditInput {
  return {
    operationId: 'op-1',
    idempotencyKey: 'key-1',
    bindingHash: 'bind-1',
    operation: 'install',
    state: 'SUCCEEDED',
    result: 'succeeded',
    actorType: 'user',
    actorId: 'user-1',
    worktreeId: 'wt-1',
    skillId: 'demo-skill',
    skillVersion: '1.2.3',
    fromVersion: null,
    toVersion: '1.2.3',
    sourceOrigin: 'github-release',
    sourceRepository: 'Kewton/commandmate-skills',
    sourceRef: 'demo-skill-v1.2.3',
    sourceCommit: 'b'.repeat(40),
    artifactSha256: 'c'.repeat(64),
    errorCode: null,
    errorMessage: null,
    recordedAt: T0,
    ...overrides,
  };
}

function catalogUnavailable(): void {
  getSkillCatalogMock.mockResolvedValue({
    ok: false,
    failure: { code: 'SKILL_CATALOG_UNREACHABLE', message: 'offline' },
  } as unknown as Awaited<ReturnType<typeof getSkillCatalog>>);
}

function catalogOffering(skillId: string, version: string): void {
  getSkillCatalogMock.mockResolvedValue({
    ok: true,
    snapshot: {
      catalog: {
        entries: [
          {
            id: skillId,
            name: skillId,
            summary: 'demo',
            provider: { name: 'CommandMate' },
            license: 'MIT',
            keywords: [],
            latest: version,
            versions: [
              {
                version,
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
                compatibility: { commandmate: '>=0.1.0', agents: [] },
              },
            ],
          },
        ],
      },
    },
  } as unknown as Awaited<ReturnType<typeof getSkillCatalog>>);
}

async function installationsRequest(query = ''): Promise<SkillInstallationsResponse> {
  const response = await getInstallations(
    new NextRequest(`http://localhost:3000/api/skills/installations${query}`)
  );
  return (await response.json()) as SkillInstallationsResponse;
}

async function operationsRequest(query = ''): Promise<SkillOperationsResponse> {
  const response = await getOperations(
    new NextRequest(`http://localhost:3000/api/skills/operations${query}`)
  );
  return (await response.json()) as SkillOperationsResponse;
}

beforeEach(() => {
  repoRoot = mkdtempSync(path.join(tmpdir(), 'cm-1248-api-'));
  db = new Database(':memory:');
  runMigrations(db);
  getDbInstanceMock.mockReturnValue(db);
  invalidateSkillStatusScanCache();
  catalogUnavailable();
});

afterEach(() => {
  db.close();
  rmSync(repoRoot, { recursive: true, force: true });
  invalidateSkillStatusScanCache();
  vi.clearAllMocks();
});

describe('GET /api/skills/installations', () => {
  it('reports applied state across worktrees with every recorded root', async () => {
    const wt1 = insertWorktree('wt-1');
    const wt2 = insertWorktree('wt-2');
    install('wt-1', wt1, 'demo-skill');
    install('wt-2', wt2, 'demo-skill', '2.0.0');

    const body = await installationsRequest('?refresh=true');

    expect(body.worktreeCount).toBe(2);
    expect(body.installations).toHaveLength(2);
    expect(body.installations[0].installRoots.map((r) => r.rootPrefix)).toEqual([
      PRIMARY,
      SECONDARY,
    ]);
  });

  it('serves no machine-absolute path', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill');

    const body = await installationsRequest('?refresh=true');

    expect(JSON.stringify(body)).not.toContain(repoRoot);
    expect(JSON.stringify(body)).not.toContain(tmpdir());
  });

  it('narrows by worktree, skill and status', async () => {
    const wt1 = insertWorktree('wt-1');
    const wt2 = insertWorktree('wt-2');
    install('wt-1', wt1, 'demo-skill');
    install('wt-2', wt2, 'other-skill');
    rmSync(path.join(wt2, SECONDARY, 'other-skill'), { recursive: true, force: true });

    expect((await installationsRequest('?refresh=true&worktreeId=wt-1')).installations).toHaveLength(
      1
    );
    expect(
      (await installationsRequest('?refresh=true&skillId=other-skill')).installations[0].worktreeId
    ).toBe('wt-2');
    const missing = await installationsRequest('?refresh=true&status=missing');
    expect(missing.installations.map((i) => i.skillId)).toEqual(['other-skill']);
  });

  it('rejects an unknown status instead of returning everything', async () => {
    const response = await getInstallations(
      new NextRequest('http://localhost:3000/api/skills/installations?status=broken')
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe('SKILL_INSTALLATIONS_INVALID_STATUS');
  });

  it('degrades to updates-unknown when the Catalog is unreachable', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill');

    const body = await installationsRequest('?refresh=true');

    expect(body.catalogAvailable).toBe(false);
    expect(body.installations[0].status).toBe('installed');
    expect(body.installations[0].latestVersion).toBeNull();
  });

  it('reports update_available when the Catalog offers a newer version', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill', '1.2.3');
    catalogOffering('demo-skill', '2.0.0');

    const body = await installationsRequest('?refresh=true');

    expect(body.catalogAvailable).toBe(true);
    expect(body.installations[0].status).toBe('update_available');
    expect(body.installations[0].latestVersion).toBe('2.0.0');
  });
});

describe('GET /api/skills/operations', () => {
  beforeEach(() => {
    insertWorktree('wt-1');
    insertWorktree('wt-2');
    recordSkillOperationAudit(db, auditInput({ operationId: 'op-a', recordedAt: T0 + 1 }));
    recordSkillOperationAudit(
      db,
      auditInput({
        operationId: 'op-b',
        worktreeId: 'wt-2',
        operation: 'uninstall',
        fromVersion: '1.2.3',
        toVersion: null,
        recordedAt: T0 + 2,
      })
    );
    recordSkillOperationAudit(
      db,
      auditInput({
        operationId: 'op-c',
        worktreeId: 'wt-2',
        result: 'failed',
        errorCode: 'SKILL_INSTALL_CONFLICT',
        errorMessage: 'destination /Users/someone/repo exists',
        recordedAt: T0 + 3,
      })
    );
  });

  it('reads across every worktree, newest first', async () => {
    const body = await operationsRequest();
    expect(body.operations.map((o) => o.operationId)).toEqual(['op-c', 'op-b', 'op-a']);
  });

  it('exposes the source coordinates an operation is traced by', async () => {
    const [newest] = (await operationsRequest('?result=succeeded')).operations;
    expect(newest).toMatchObject({
      sourceOrigin: 'github-release',
      sourceRepository: 'Kewton/commandmate-skills',
      sourceCommit: 'b'.repeat(40),
      artifactSha256: 'c'.repeat(64),
      result: 'succeeded',
    });
  });

  it('carries the version transition of an uninstall', async () => {
    const [entry] = (await operationsRequest('?operation=uninstall')).operations;
    expect(entry.fromVersion).toBe('1.2.3');
    expect(entry.toVersion).toBeNull();
  });

  it('serves error codes without the redacted path', async () => {
    const [failure] = (await operationsRequest('?result=failed')).operations;
    expect(failure.errorCode).toBe('SKILL_INSTALL_CONFLICT');
    expect(failure.errorMessage).not.toContain('/Users/someone');
  });

  it('pages with an opaque cursor', async () => {
    const first = await operationsRequest('?limit=2');
    expect(first.operations).toHaveLength(2);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();

    const second = await operationsRequest(
      `?limit=2&cursor=${encodeURIComponent(first.nextCursor as string)}`
    );
    expect(second.operations.map((o) => o.operationId)).toEqual(['op-a']);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
  });

  it.each([
    ['operation=rollback', 'SKILL_OPERATIONS_INVALID_OPERATION'],
    ['result=faild', 'SKILL_OPERATIONS_INVALID_RESULT'],
    ['since=yesterday', 'SKILL_OPERATIONS_INVALID_TIME_RANGE'],
    ['cursor=garbage', 'SKILL_OPERATIONS_INVALID_CURSOR'],
    ['limit=0', 'SKILL_OPERATIONS_INVALID_LIMIT'],
  ])('rejects ?%s rather than ignoring it', async (query, code) => {
    const response = await getOperations(
      new NextRequest(`http://localhost:3000/api/skills/operations?${query}`)
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe(code);
  });
});

describe('POST /api/skills/reindex', () => {
  it('rebuilds the index from receipts after the table is emptied', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill');
    db.prepare('DELETE FROM skill_installations').run();

    const response = await postReindex();
    const body = (await response.json()) as SkillReindexResponse;

    expect(response.status).toBe(200);
    expect(body.indexed).toBe(1);

    const rebuilt = await installationsRequest();
    expect(rebuilt.installations).toHaveLength(1);
    expect(rebuilt.installations[0].status).toBe('installed');
    expect(rebuilt.installations[0].installRoots.map((r) => r.root)).toEqual([
      '.agents/skills/demo-skill',
      '.claude/skills/demo-skill',
    ]);
  });

  it('makes the rebuild visible to the next scan instead of serving the cache', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill');
    db.prepare('DELETE FROM skill_installations').run();

    const before = await installationsRequest();
    expect(before.installations[0].status).toBe('unmanaged');

    await postReindex();

    const after = await installationsRequest();
    expect(after.installations[0].status).toBe('installed');
  });

  it('does not append to the append-only operation log', async () => {
    const wt = insertWorktree('wt-1');
    install('wt-1', wt, 'demo-skill');

    await postReindex();

    const count = db.prepare('SELECT COUNT(*) AS n FROM skill_operations').get() as { n: number };
    expect(count.n).toBe(0);
  });
});
