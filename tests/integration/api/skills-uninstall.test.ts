/**
 * API integration tests — Uninstall plan and apply routes (Issue #1236)
 *
 * Runs the real vertical slice both ways: the #1235 install route puts a real
 * package into a real temporary worktree and records it in a real database, and
 * then the uninstall routes take it back out again. Only the network edges are
 * mocked — the Catalog, the artifact download and the snapshot store — because
 * `Kewton/commandmate-skills` is private and an uninstall touches the network at
 * no point anyway.
 *
 * The assertions to read closely are the negative ones. For every way a Skill
 * directory can become ambiguous, the check is not that the API returned 409 but
 * that the files are still there afterwards.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { SkillCatalog } from '@/types/skills';
import type { SkillCatalogResult } from '@/lib/skills/catalog-client';

const state = vi.hoisted(() => ({ configRoot: '' }));

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

// Locks, journals and audit state must land in a throwaway directory rather
// than in the developer's real CommandMate config root.
vi.mock('@/cli/utils/install-context', () => ({
  ensureConfigDir: () => state.configRoot,
  getConfigDir: () => state.configRoot,
  isGlobalInstall: () => false,
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn() }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/skills/catalog-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/catalog-client')>();
  return { ...actual, getSkillCatalog: vi.fn() };
});
vi.mock('@/lib/skills/artifact-downloader', () => ({ downloadSkillArtifact: vi.fn() }));
vi.mock('@/lib/skills/snapshot-store', () => ({
  initSkillSnapshotStore: vi.fn(() => '/tmp/snapshots'),
  createSkillSnapshot: vi.fn(),
  getSkillSnapshot: vi.fn(),
  readSkillSnapshotBytes: vi.fn(),
  releaseSkillSnapshot: vi.fn(),
}));
vi.mock('@/lib/version-checker', () => ({ getServerVersion: vi.fn(() => '0.11.4') }));
vi.mock('@/lib/git/git-exec', () => ({ execGitCommand: vi.fn(), execFileAsync: vi.fn() }));

import { POST as buildInstallPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
import { POST as applyInstall } from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
import { POST as buildUninstallPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall-plan/route';
import { POST as applyUninstall } from '@/app/api/worktrees/[id]/skills/[skillId]/uninstall/route';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import {
  createSkillSnapshot,
  getSkillSnapshot,
  readSkillSnapshotBytes,
} from '@/lib/skills/snapshot-store';
import { execGitCommand, execFileAsync } from '@/lib/git/git-exec';
import {
  SKILL_RECEIPT_FILENAME,
  resetSkillInstallPlanCacheForTesting,
} from '@/lib/skills/install-plan';
import { resetSkillUninstallPlanCacheForTesting } from '@/lib/skills/uninstall-plan';
import { getSkillInstallation } from '@/lib/skills/installed-state';
import { listSkillOperationAudit } from '@/lib/skills/operation-audit';
import { runMigrations } from '@/lib/db/db-migrations';
import { buildPackage } from '../../fixtures/skills/malicious-packages/package';
import type { PackageFileSpec } from '../../fixtures/skills/malicious-packages/package';
import type { Worktree } from '@/types/models';

const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const getDbInstanceMock = vi.mocked(getDbInstance);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const downloadSkillArtifactMock = vi.mocked(downloadSkillArtifact);
const createSkillSnapshotMock = vi.mocked(createSkillSnapshot);
const getSkillSnapshotMock = vi.mocked(getSkillSnapshot);
const readSkillSnapshotBytesMock = vi.mocked(readSkillSnapshotBytes);
const execGitCommandMock = vi.mocked(execGitCommand);
const execFileAsyncMock = vi.mocked(execFileAsync) as unknown as ReturnType<typeof vi.fn>;

const SKILL_ID = 'demo-skill';
const VERSION = '1.2.3';
const WORKTREE_ID = 'wt-00000000-0000-4000-8000-000000000001';
const COMMIT = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';
const HEAD = 'f'.repeat(40);
const SNAPSHOT_ID = 'a'.repeat(32);

let worktreeDir: string;
let configRoot: string;
let db: Database.Database;
let artifact: Buffer;
let artifactSha: string;

// =============================================================================
// Harness
// =============================================================================

function installRootAbs(): string {
  return path.join(worktreeDir, '.agents', 'skills', SKILL_ID);
}

function makeCatalog(): SkillCatalog {
  return {
    schema_version: 1,
    entries: [
      {
        id: SKILL_ID,
        name: 'Demo Skill',
        summary: 'A demo Skill used by the CommandMate package tests.',
        provider: { name: 'CommandMate' },
        license: 'MIT',
        latest: VERSION,
        versions: [
          {
            version: VERSION,
            changelog: `Release ${VERSION}`,
            published_at: '2026-07-16T09:30:00Z',
            source: { repository: 'Kewton/commandmate-skills', ref: `v${VERSION}`, commit: COMMIT },
            artifact: {
              asset_name: `${SKILL_ID}-${VERSION}.tar.gz`,
              url: `https://example.invalid/${SKILL_ID}-${VERSION}.tar.gz`,
              sha256: artifactSha,
              size: artifact.byteLength,
              content_type: 'application/gzip',
              format: 'tar.gz',
            },
            compatibility: {
              commandmate: '>=0.11.0 <1.0.0',
              agents: [
                { agent: 'claude', support: 'native', evidence: 'verified by the package tests' },
              ],
            },
            declared_risk: 'low',
          },
        ],
      },
    ],
  };
}

function wireMocks(): void {
  getSkillCatalogMock.mockResolvedValue({
    ok: true,
    snapshot: {
      catalog: makeCatalog(),
      fetchedAt: '2026-07-16T10:00:00Z',
      revalidatedAt: '2026-07-16T10:00:00Z',
      stale: false,
      offline: false,
      state: 'fresh',
      staleReason: null,
      source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: null },
    },
  } as SkillCatalogResult);

  downloadSkillArtifactMock.mockResolvedValue({
    skillId: SKILL_ID,
    version: VERSION,
    commit: COMMIT,
    bytes: artifact,
    sha256: artifactSha,
    size: artifact.byteLength,
  });

  const handle = {
    snapshotId: SNAPSHOT_ID,
    skillId: SKILL_ID,
    version: VERSION,
    commit: COMMIT,
    sha256: artifactSha,
    size: artifact.byteLength,
    expiresAt: Date.now() + 600_000,
  };
  createSkillSnapshotMock.mockReturnValue(handle);
  getSkillSnapshotMock.mockReturnValue(handle);
  readSkillSnapshotBytesMock.mockImplementation(() => artifact);
}

/**
 * The route resolves the worktree through the DB; since #1430 the install index
 * has a foreign key to it, so the row has to be in the test database too.
 */
function seedWorktreeRow(db: Database.Database): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, 'demo-worktree', ?, ?, 'commandmate')`
  ).run(WORKTREE_ID, worktreeDir, path.dirname(worktreeDir));
}

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'demo-worktree',
    path: worktreeDir,
    branch: 'feature/demo',
    repositoryName: 'commandmate',
    repositoryDisplayName: 'CommandMate',
  } as Worktree;
}

function post(
  handler: (request: NextRequest, ctx: { params: Promise<{ id: string; skillId: string }> }) => Promise<Response>,
  segment: string,
  body: Record<string, unknown> | null,
  headers: Record<string, string> = {}
): Promise<Response> {
  return handler(
    new NextRequest(
      `http://localhost/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/${segment}`,
      {
        method: 'POST',
        headers,
        ...(body === null ? {} : { body: JSON.stringify(body) }),
      }
    ),
    { params: Promise.resolve({ id: WORKTREE_ID, skillId: SKILL_ID }) }
  );
}

/** Rebuild the mocked artifact, so a re-install can carry different bytes. */
function useArtifact(files?: PackageFileSpec[]): void {
  const built = buildPackage({ skillId: SKILL_ID, version: VERSION, ...(files ? { files } : {}) });
  artifact = built.bytes;
  artifactSha = createHash('sha256').update(artifact).digest('hex');
  wireMocks();
}

/**
 * Put a real install into the worktree through the real install route.
 *
 * The idempotency key is explicit because the mocked snapshot ID is a constant:
 * without it two installs of the same bytes derive the same key and the second
 * would be answered as a replay rather than actually writing anything.
 */
async function installSkill(idempotencyKey = 'install-key-00000001'): Promise<void> {
  const planResponse = await post(buildInstallPlan, 'plan', {});
  expect(planResponse.status).toBe(200);
  const { plan } = await planResponse.json();
  const installed = await post(applyInstall, 'install', {
    planToken: plan.token,
    version: VERSION,
    idempotencyKey,
  });
  expect(installed.status).toBe(200);
}

/** Build an uninstall plan and hand back its token and DTO. */
async function issueUninstallPlan(
  headers: Record<string, string> = {}
): Promise<{ token: string; plan: Record<string, never> & Record<string, unknown> }> {
  const response = await post(buildUninstallPlan, 'uninstall-plan', null, headers);
  expect(response.status).toBe(200);
  const payload = await response.json();
  return { token: payload.plan.token, plan: payload.plan };
}

/** Payload files are written 0600, so an edit needs the bit put back first. */
function overwrite(relative: string, content: string): void {
  const target = path.join(installRootAbs(), relative);
  chmodSync(target, 0o600);
  writeFileSync(target, content);
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetSkillInstallPlanCacheForTesting();
  resetSkillUninstallPlanCacheForTesting();

  worktreeDir = mkdtempSync(path.join(tmpdir(), 'cm-uninstall-wt-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'cm-uninstall-cfg-'));
  state.configRoot = configRoot;

  db = new Database(':memory:');
  runMigrations(db);
  seedWorktreeRow(db);
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());

  useArtifact();
  execGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'feature/demo';
    if (args[0] === 'rev-parse') return HEAD;
    if (args[0] === 'status') return '';
    return null;
  });
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });

  await installSkill();
});

afterEach(() => {
  db.close();
  rmSync(worktreeDir, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

// =============================================================================
// Plan
// =============================================================================

describe('POST …/uninstall-plan', () => {
  it('lists what would be removed, receipt included', async () => {
    const { plan } = await issueUninstallPlan();

    expect(plan.removable).toBe(true);
    expect(plan.nextActionKey).toBe('skills.uninstall.nextAction.removable');
    expect((plan.removals as Array<{ path: string }>).map((entry) => entry.path)).toContain(
      `.agents/skills/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`
    );
    expect(plan.retained).toEqual([]);
    expect(plan.skill).toMatchObject({ id: SKILL_ID, version: VERSION });
  });

  it('explains which file blocks removal instead of offering a partial delete', async () => {
    overwrite('reference/notes.md', '# Notes\n\nmine now\n');

    const { plan } = await issueUninstallPlan();

    expect(plan.removable).toBe(false);
    expect(plan.nextActionKey).toBe('skills.uninstall.nextAction.blocked');
    expect(plan.blockers).toContainEqual(
      expect.objectContaining({
        code: 'SKILL_UNINSTALL_LOCAL_MODIFICATION',
        path: `.agents/skills/${SKILL_ID}/reference/notes.md`,
        messageKey: 'skills.uninstall.reason.localModification',
      })
    );
  });

  it('reports nothing installed for a Skill that is not there', async () => {
    rmSync(installRootAbs(), { recursive: true });

    const response = await post(buildUninstallPlan, 'uninstall-plan', null);

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('SKILL_UNINSTALL_NOT_INSTALLED');
  });

  it('refuses a body that tries to name the target itself', async () => {
    const response = await post(buildUninstallPlan, 'uninstall-plan', {
      installRoot: '/etc',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_PLAN_INPUT_REJECTED');
  });
});

// =============================================================================
// Apply — success
// =============================================================================

describe('POST …/uninstall — success', () => {
  it('removes the payload, the directories and the receipt', async () => {
    const { token } = await issueUninstallPlan();

    const response = await post(applyUninstall, 'uninstall', { planToken: token });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.operation).toMatchObject({
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      replayed: false,
      nextActionKey: 'skills.uninstall.nextAction.succeeded',
    });
    expect(payload.uninstall).toMatchObject({
      skillId: SKILL_ID,
      version: VERSION,
      installRoot: `.agents/skills/${SKILL_ID}`,
      receiptRemoved: true,
      fullyRemoved: true,
      retained: [],
    });
    expect(existsSync(installRootAbs())).toBe(false);
  });

  it('clears the index row and appends an uninstall audit row', async () => {
    const { token } = await issueUninstallPlan();

    await post(applyUninstall, 'uninstall', { planToken: token });

    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).toBeNull();

    const audit = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID });
    expect(audit[0]).toMatchObject({
      operation: 'uninstall',
      result: 'succeeded',
      state: 'SUCCEEDED',
      actorType: 'user',
      skillVersion: VERSION,
      sourceRepository: 'Kewton/commandmate-skills',
      sourceCommit: COMMIT,
      artifactSha256: artifactSha,
    });
  });

  it('tells each agent how to stop offering the Skill', async () => {
    const { token } = await issueUninstallPlan();

    const payload = await (await post(applyUninstall, 'uninstall', { planToken: token })).json();

    expect(payload.reload.agents).toEqual([
      { agent: 'claude', support: 'native', messageKey: 'skills.uninstall.reload.native' },
    ]);
  });

  it('leaves an unrelated directory the user created, and names it', async () => {
    mkdirSync(path.join(installRootAbs(), 'scratch'));
    const { token } = await issueUninstallPlan();

    const payload = await (await post(applyUninstall, 'uninstall', { planToken: token })).json();

    expect(payload.uninstall.fullyRemoved).toBe(false);
    expect(payload.uninstall.retained).toContainEqual(
      expect.objectContaining({ path: `.agents/skills/${SKILL_ID}/scratch` })
    );
    expect(existsSync(path.join(installRootAbs(), 'scratch'))).toBe(true);
  });
});

// =============================================================================
// Apply — zero-delete
// =============================================================================

describe('POST …/uninstall — nothing is deleted when anything is ambiguous', () => {
  it('refuses a plan that was already blocked, without spending the token', async () => {
    writeFileSync(path.join(installRootAbs(), 'my-notes.md'), 'keep me\n');
    const { token } = await issueUninstallPlan();

    const response = await post(applyUninstall, 'uninstall', { planToken: token });

    expect(response.status).toBe(409);
    const payload = await response.json();
    expect(payload.code).toBe('SKILL_UNINSTALL_BLOCKED');
    expect(payload.nextActionKey).toBe('skills.uninstall.nextAction.blocked');
    expect(payload.blockers.map((entry: { code: string }) => entry.code)).toContain(
      'SKILL_UNINSTALL_UNMANAGED_FILE'
    );
    expect(readFileSync(path.join(installRootAbs(), 'my-notes.md'), 'utf-8')).toBe('keep me\n');
    expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });

  it('refuses when a file changed after the plan was built', async () => {
    const { token } = await issueUninstallPlan();
    overwrite('reference/notes.md', '# Notes\n\nedited after planning\n');

    const response = await post(applyUninstall, 'uninstall', { planToken: token });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expect(existsSync(path.join(installRootAbs(), 'assets/logo.svg'))).toBe(true);
    expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).not.toBeNull();
  });

  it('refuses when a different version was installed between plan and apply', async () => {
    const { token } = await issueUninstallPlan();
    rmSync(installRootAbs(), { recursive: true });
    resetSkillInstallPlanCacheForTesting();
    useArtifact([{ path: 'reference/notes.md', content: '# Different package\n' }]);
    await installSkill('install-key-00000002');

    const response = await post(applyUninstall, 'uninstall', { planToken: token });

    // The token was issued against a receipt that is no longer the one on disk,
    // so spending it would delete an install the user never previewed.
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);
    expect(existsSync(path.join(installRootAbs(), 'reference/notes.md'))).toBe(true);
  });

  it('refuses a body that tries to force the delete', async () => {
    const { token } = await issueUninstallPlan();

    const response = await post(applyUninstall, 'uninstall', { planToken: token, force: true });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_PLAN_INPUT_REJECTED');
    expect(existsSync(installRootAbs())).toBe(true);
  });
});

// =============================================================================
// Token contract
// =============================================================================

describe('POST …/uninstall — the token contract', () => {
  it('refuses a second apply of the same token', async () => {
    const { token } = await issueUninstallPlan();
    expect((await post(applyUninstall, 'uninstall', { planToken: token })).status).toBe(200);

    const replay = await post(applyUninstall, 'uninstall', { planToken: token });

    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('SKILL_PLAN_CONSUMED');
  });

  it('refuses a browser token presented by the CLI', async () => {
    const { token } = await issueUninstallPlan();

    const response = await post(
      applyUninstall,
      'uninstall',
      { planToken: token },
      { authorization: 'Bearer local-token' }
    );

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_BINDING_MISMATCH');
    expect(existsSync(installRootAbs())).toBe(true);
  });

  it('refuses a token that is not a token at all', async () => {
    const response = await post(applyUninstall, 'uninstall', { planToken: 'nope' });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_UNINSTALL_INVALID_BODY');
  });

  it('replays a retried request instead of running it twice', async () => {
    const { token } = await issueUninstallPlan();
    const key = 'uninstall-retry-key-0001';
    expect(
      (await post(applyUninstall, 'uninstall', { planToken: token, idempotencyKey: key })).status
    ).toBe(200);

    const replay = await post(applyUninstall, 'uninstall', {
      planToken: token,
      idempotencyKey: key,
    });

    expect(replay.status).toBe(200);
    const payload = await replay.json();
    expect(payload.operation).toMatchObject({ replayed: true, state: 'SUCCEEDED' });
    const uninstalls = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID }).filter(
      (row) => row.operation === 'uninstall'
    );
    expect(uninstalls).toHaveLength(1);
  });
});

// =============================================================================
// Partial failure
// =============================================================================

describe('POST …/uninstall — a failure part-way through', () => {
  const asRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(asRoot)('keeps the receipt and audits the failure without leaking paths', async () => {
    const { token } = await issueUninstallPlan();
    // Deletion needs write permission on the parent directory. Read permission
    // is untouched, so nothing about the plan's view of the tree changes.
    chmodSync(path.join(installRootAbs(), 'reference'), 0o500);

    try {
      const response = await post(applyUninstall, 'uninstall', { planToken: token });

      expect(response.status).toBe(500);
      expect((await response.json()).code).toBe('SKILL_UNINSTALL_DELETE_FAILED');
      expect(existsSync(path.join(installRootAbs(), 'reference/notes.md'))).toBe(true);
      expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);

      const audit = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID });
      const failure = audit.find((row) => row.result === 'failed');
      expect(failure).toMatchObject({
        operation: 'uninstall',
        state: 'FAILED_RECONCILABLE',
        errorCode: 'SKILL_UNINSTALL_DELETE_FAILED',
      });
      expect(failure?.errorMessage ?? '').not.toContain(worktreeDir);
    } finally {
      chmodSync(path.join(installRootAbs(), 'reference'), 0o700);
    }
  });
});
