/**
 * Skill update: plan → apply → receipt → discovery → audit, end to end (Issue #1244)
 *
 * @vitest-environment node
 *
 * The update counterpart of the MVP install flow suite: a real git repository,
 * the real snapshot/staging/filesystem layers and the real route handlers, with
 * only the Catalog document and the artifact download stubbed so the suite
 * never reaches the network.
 *
 * What this suite proves that the unit tests cannot, because it needs the whole
 * stack: that the update route refuses a local change with **zero writes**,
 * refuses a token whose world moved, answers a retried request from its
 * recorded outcome instead of switching twice, and leaves an audit row carrying
 * the old→new versions and the source coordinates with no machine path in it.
 */

import path from 'path';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import Database from 'better-sqlite3';
import { NextRequest } from 'next/server';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

// Locks, journals, snapshots and update backups must land in a throwaway root,
// never in the developer's real ~/.commandmate.
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
vi.mock('@/lib/version-checker', () => ({ getServerVersion: vi.fn(() => '0.11.4') }));

import { POST as buildPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
import { POST as applyInstall } from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
import { POST as buildUpdatePlan } from '@/app/api/worktrees/[id]/skills/[skillId]/update-plan/route';
import { POST as applyUpdate } from '@/app/api/worktrees/[id]/skills/[skillId]/update/route';
import { GET as listSkills } from '@/app/api/worktrees/[id]/skills/route';
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  SKILL_RECEIPT_FILENAME,
  parseInstalledReceipt,
  resetSkillInstallPlanCacheForTesting,
} from '@/lib/skills/install-plan';
import { resetSkillUpdatePlanCacheForTesting } from '@/lib/skills/update-plan';
import { resetSkillSnapshotStoreForTesting } from '@/lib/skills/snapshot-store';
import { getSkillInstallation } from '@/lib/skills/installed-state';
import { listSkillOperationAudit } from '@/lib/skills/operation-audit';
import { readSkillUpdateBackupManifest } from '@/lib/skills/updater';
import { hasSkillUpdate } from '@/lib/skills/version-resolver';
import { loadAgentsSkills, loadSkills } from '@/lib/slash-commands';
import type { SkillCatalog, SkillCatalogEntry } from '@/types/skills';
import type { Worktree } from '@/types/models';
import {
  CATALOG_REPOSITORY,
  WORKTREE_ID,
  buildArtifact,
  catalogResult,
  catalogVersionFor,
  createTestRoot,
  initGitRepo,
  installRootOf,
  removeTestRoot,
  seedWorktreeRow,
  snapshotTree,
  treeDelta,
  type BuiltArtifact,
} from './skills/mvp-harness';

const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const getDbInstanceMock = vi.mocked(getDbInstance);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const downloadSkillArtifactMock = vi.mocked(downloadSkillArtifact);

const SKILL_ID = 'cmate-repository-analysis';
const FROM_VERSION = '0.1.0';
const TO_VERSION = '0.2.0';

let worktreeDir: string;
let configRoot: string;
let db: Database.Database;
let artifacts: Map<string, BuiltArtifact>;

// =============================================================================
// Harness
// =============================================================================

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'demo-worktree',
    path: worktreeDir,
    branch: 'main',
    repositoryName: 'commandmate',
    repositoryDisplayName: 'CommandMate',
  } as Worktree;
}

/**
 * A Catalog carrying both versions of the one Skill under test.
 *
 * The MVP harness publishes a single version per Skill, which is exactly what
 * an update cannot be planned from — the resolver needs a strictly newer
 * published candidate to offer.
 */
function buildTwoVersionCatalog(): SkillCatalog {
  const entry: SkillCatalogEntry = {
    id: SKILL_ID,
    name: 'Repository Analysis',
    summary: `Fixture Skill ${SKILL_ID}.`,
    provider: { name: 'CommandMate' },
    license: 'MIT',
    latest: TO_VERSION,
    versions: [
      catalogVersionFor(artifacts.get(TO_VERSION)!),
      catalogVersionFor(artifacts.get(FROM_VERSION)!),
    ],
  } as SkillCatalogEntry;
  return { schema_version: 1, entries: [entry] } as SkillCatalog;
}

function wireCatalog(): void {
  getSkillCatalogMock.mockResolvedValue(catalogResult(buildTwoVersionCatalog()) as never);
  // Version-aware, unlike the install-flow suite's stub: the update path asks
  // for a *different* version than the one already installed.
  downloadSkillArtifactMock.mockImplementation(async (skillId, version) => {
    const artifact = artifacts.get(version.version);
    if (!artifact) throw new Error(`no fixture artifact for ${skillId}@${version.version}`);
    return {
      skillId: artifact.skillId,
      version: artifact.version,
      commit: artifact.commit,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      size: artifact.size,
    };
  });
}

/** `authorization` present ⇒ the route binds the plan to the `cli` actor. */
function routeRequest(url: string, body: unknown, asCli: boolean): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
    ...(asCli ? { headers: { authorization: 'Bearer test-token' } } : {}),
  });
}

function params() {
  return { params: Promise.resolve({ id: WORKTREE_ID, skillId: SKILL_ID }) };
}

/**
 * Install the *older* version, explicitly.
 *
 * The plan route offers the recommended (newest) version by default, and an
 * install of the newest version has nothing to update to — the update plan
 * would answer `up to date` and every case below would test the 404 path.
 */
async function installFromVersion(): Promise<void> {
  const planResponse = await buildPlan(
    routeRequest(
      `/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/plan`,
      { version: FROM_VERSION },
      false
    ),
    params()
  );
  expect(planResponse.status).toBe(200);
  const plan = ((await planResponse.json()) as Record<string, never>).plan as Record<string, never>;

  const installResponse = await applyInstall(
    routeRequest(
      `/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/install`,
      {
        planToken: plan.token,
        version: (plan.skill as Record<string, string>).version,
        acknowledgeRisk: Boolean(plan.requiresRiskAcknowledgement),
      },
      false
    ),
    params()
  );
  expect(installResponse.status).toBe(200);
}

interface UpdatePlanBody {
  token: string;
  updatable: boolean;
  blockers: Array<{ code: string; path: string | null }>;
  update: { fromVersion: string; toVersion: string };
  requiresRiskAcknowledgement: boolean;
  riskIncreased: boolean;
}

async function requestUpdatePlan(body: unknown = {}): Promise<Response> {
  return buildUpdatePlan(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/update-plan`, body, false),
    params()
  );
}

async function updatePlanOrThrow(body: unknown = {}): Promise<UpdatePlanBody> {
  const response = await requestUpdatePlan(body);
  expect(response.status).toBe(200);
  return ((await response.json()) as { plan: UpdatePlanBody }).plan;
}

async function requestUpdate(body: unknown): Promise<Response> {
  return applyUpdate(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/update`, body, false),
    params()
  );
}

/** The plan's own token, spent with the confirmations the plan demands. */
async function applyPlan(
  plan: UpdatePlanBody,
  extra: Record<string, unknown> = {}
): Promise<Response> {
  return requestUpdate({
    planToken: plan.token,
    version: plan.update.toVersion,
    acknowledgeRisk: plan.requiresRiskAcknowledgement,
    acknowledgeRiskIncrease: plan.riskIncreased,
    ...extra,
  });
}

/** The list route the #1441/#1442 UIs read (#1753). */
async function listInstalledSkills(): Promise<Response> {
  return listSkills(
    new NextRequest(`http://localhost/api/worktrees/${WORKTREE_ID}/skills`),
    { params: Promise.resolve({ id: WORKTREE_ID }) }
  );
}

function installedReceiptVersion(prefix = '.agents/skills'): string | null {
  const receiptPath = path.join(
    worktreeDir,
    prefix,
    SKILL_ID,
    SKILL_RECEIPT_FILENAME
  );
  if (!existsSync(receiptPath)) return null;
  return parseInstalledReceipt(readFileSync(receiptPath))?.version ?? null;
}

beforeEach(async () => {
  vi.clearAllMocks();
  resetSkillInstallPlanCacheForTesting();
  resetSkillUpdatePlanCacheForTesting();
  resetSkillSnapshotStoreForTesting();

  worktreeDir = createTestRoot('wt');
  configRoot = createTestRoot('cfg');
  state.configRoot = configRoot;
  initGitRepo(worktreeDir);

  db = new Database(':memory:');
  runMigrations(db);
  seedWorktreeRow(db, worktreeDir);
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());

  artifacts = new Map([
    [FROM_VERSION, buildArtifact(SKILL_ID, FROM_VERSION)],
    [
      TO_VERSION,
      buildArtifact(SKILL_ID, TO_VERSION, {
        files: [
          { path: 'reference/notes.md', content: '# Notes\n\nRewritten for 0.2.0.\n' },
          { path: 'docs/extra.md', content: '# Extra\n\nNew in 0.2.0.\n' },
        ],
      }),
    ],
  ]);
  wireCatalog();

  await installFromVersion();
});

afterEach(() => {
  db.close();
  resetSkillSnapshotStoreForTesting();
  removeTestRoot(worktreeDir);
  removeTestRoot(configRoot);
});

// =============================================================================
// Happy path
// =============================================================================

describe('Skill update: plan → apply → receipt → discovery → audit', () => {
  it('switches a clean install to the new version in both roots', async () => {
    expect(installedReceiptVersion()).toBe(FROM_VERSION);

    const plan = await updatePlanOrThrow();
    expect(plan.updatable).toBe(true);
    expect(plan.update).toMatchObject({ fromVersion: FROM_VERSION, toVersion: TO_VERSION });

    const response = await applyPlan(plan);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, never>;
    expect((body.operation as Record<string, string>).result).toBe('succeeded');
    expect(body.update as Record<string, string>).toMatchObject({
      skillId: SKILL_ID,
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
    });

    // Both roots (#1460) now hold the new version, and nothing of the old one.
    expect(installedReceiptVersion('.agents/skills')).toBe(TO_VERSION);
    expect(installedReceiptVersion('.claude/skills')).toBe(TO_VERSION);
    for (const prefix of ['.agents/skills', '.claude/skills']) {
      const root = path.join(worktreeDir, prefix, SKILL_ID);
      expect(readFileSync(path.join(root, 'reference/notes.md'), 'utf-8')).toContain('0.2.0');
      expect(existsSync(path.join(root, 'docs/extra.md'))).toBe(true);
      expect(existsSync(path.join(root, 'assets/logo.svg'))).toBe(false);
    }

    // The index follows the receipt, and both Agent discovery paths see it.
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)?.version).toBe(TO_VERSION);
    expect((await loadAgentsSkills(worktreeDir)).map((c) => c.name)).toContain(
      'Repository Analysis'
    );
    expect((await loadSkills(worktreeDir)).map((c) => c.name)).toContain('Repository Analysis');
  });

  it('records an audit row carrying old→new versions, source and no machine path', async () => {
    const plan = await updatePlanOrThrow();
    expect((await applyPlan(plan)).status).toBe(200);

    const audit = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID, skillId: SKILL_ID });
    const update = audit.filter((row) => row.operation === 'update');
    expect(update).toHaveLength(1);
    expect(update[0]).toMatchObject({
      result: 'succeeded',
      fromVersion: FROM_VERSION,
      toVersion: TO_VERSION,
      skillVersion: TO_VERSION,
      sourceOrigin: 'github-release',
      sourceRepository: CATALOG_REPOSITORY,
      actorType: 'user',
    });
    expect(update[0].sourceCommit).toBe(artifacts.get(TO_VERSION)!.commit);
    expect(update[0].artifactSha256).toBe(artifacts.get(TO_VERSION)!.sha256);

    // Redaction: no machine-absolute path reaches the log, by any column.
    expect(JSON.stringify(update[0])).not.toContain(worktreeDir);
    expect(JSON.stringify(update[0])).not.toContain(configRoot);
  });

  it('keeps a verified backup of the replaced payload outside the repository', async () => {
    const plan = await updatePlanOrThrow();
    const response = await applyPlan(plan);
    const body = (await response.json()) as Record<string, never>;
    const rollback = body.rollback as Record<string, never>;
    const backup = rollback.backup as unknown as { backupId: string; fromVersion: string };

    expect(rollback.available).toBe(true);
    expect(backup.fromVersion).toBe(FROM_VERSION);

    const manifest = readSkillUpdateBackupManifest(backup.backupId);
    expect(manifest).not.toBeNull();
    expect(manifest!.fromVersion).toBe(FROM_VERSION);
    expect(manifest!.toVersion).toBe(TO_VERSION);
    // Service-owned: under the config root, never inside the worktree.
    expect(existsSync(path.join(configRoot, 'skills', 'backups', backup.backupId))).toBe(true);
    expect(existsSync(path.join(worktreeDir, '.agents/skills/.commandmate-staging'))).toBe(false);
  });

  it('serves no machine-absolute path in the response body', async () => {
    const plan = await updatePlanOrThrow();
    const response = await applyPlan(plan);
    const text = JSON.stringify(await response.json());

    expect(text).not.toContain(worktreeDir);
    expect(text).not.toContain(configRoot);
    expect(text).toContain(`.agents/skills/${SKILL_ID}`);
  });
});

// =============================================================================
// Refusals — nothing is written
// =============================================================================

describe('Skill update: zero-write refusals', () => {
  it('refuses a locally modified install and leaves every byte in place', async () => {
    const notes = path.join(installRootOf(worktreeDir, SKILL_ID), 'reference/notes.md');
    writeFileSync(notes, '# Notes\n\nMy own edit.\n');

    const plan = await updatePlanOrThrow();
    expect(plan.updatable).toBe(false);
    expect(plan.blockers.map((blocker) => blocker.code)).toContain(
      'SKILL_UPDATE_LOCAL_CHANGES'
    );

    const before = snapshotTree(worktreeDir);
    const response = await applyPlan(plan);
    expect(response.status).toBe(409);
    const body = (await response.json()) as Record<string, never>;
    expect(body.code).toBe('SKILL_UPDATE_LOCAL_CHANGES');
    expect(Array.isArray(body.blockers)).toBe(true);

    expect(treeDelta(before, snapshotTree(worktreeDir))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(installedReceiptVersion()).toBe(FROM_VERSION);
    expect(readFileSync(notes, 'utf-8')).toContain('My own edit.');
  });

  it('refuses a plan whose install moved after the preview (stale), writing nothing', async () => {
    const plan = await updatePlanOrThrow();
    expect(plan.updatable).toBe(true);

    // The world moves between preview and apply: an unmanaged file appears.
    writeFileSync(path.join(installRootOf(worktreeDir, SKILL_ID), 'scratch.txt'), 'later\n');
    const before = snapshotTree(worktreeDir);

    const response = await applyPlan(plan);
    expect(response.status).toBe(409);
    expect(((await response.json()) as Record<string, string>).code).toBe('SKILL_PLAN_STALE');

    expect(treeDelta(before, snapshotTree(worktreeDir))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(installedReceiptVersion()).toBe(FROM_VERSION);
  });

  it('refuses a token that was already spent', async () => {
    const plan = await updatePlanOrThrow();
    expect((await applyPlan(plan)).status).toBe(200);

    const replayed = await applyPlan(plan);
    expect(replayed.status).toBe(409);
    expect(((await replayed.json()) as Record<string, string>).code).toBe('SKILL_PLAN_CONSUMED');
  });

  it('rejects a body that tries to name a path or an artifact', async () => {
    const plan = await updatePlanOrThrow();
    const response = await requestUpdate({
      planToken: plan.token,
      version: plan.update.toVersion,
      installRoot: '/etc',
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as Record<string, string>).code).toBe(
      'SKILL_PLAN_INPUT_REJECTED'
    );
    expect(installedReceiptVersion()).toBe(FROM_VERSION);
  });
});

// =============================================================================
// Drift between the index and the receipt (#1753)
// =============================================================================

/**
 * The reported failure, end to end.
 *
 * Something moved the payload on disk without going through this server — the
 * production evidence was three receipts sharing an mtime with no rows in
 * `skill_operations` — so the index kept naming the version that was installed
 * before. The list route served that stale version, the screen offered an
 * update to a version the receipt already had, and the update route (which
 * reads the receipt) rejected it as not strictly newer. The message read as
 * "you are already up to date" while the update button was still there.
 *
 * The state is reconstructed by rewinding the *row* after a real update, so
 * disk and index disagree exactly as they did in production: a row naming
 * {@link FROM_VERSION} with the digest of the receipt that version wrote,
 * over a payload that is at {@link TO_VERSION}.
 */
describe('Skill update: an index that drifted from the receipt', () => {
  async function driftIndexBehindDisk(): Promise<void> {
    const before = getSkillInstallation(db, WORKTREE_ID, SKILL_ID);
    expect(before?.version).toBe(FROM_VERSION);

    expect((await applyPlan(await updatePlanOrThrow())).status).toBe(200);
    expect(installedReceiptVersion()).toBe(TO_VERSION);

    db.prepare(
      'UPDATE skill_installations SET version = ?, receipt_sha256 = ? WHERE worktree_id = ? AND skill_id = ?'
    ).run(before!.version, before!.receiptSha256, WORKTREE_ID, SKILL_ID);
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)?.version).toBe(FROM_VERSION);
  }

  it('lists the version the receipt records, not the one the row kept', async () => {
    await driftIndexBehindDisk();

    const response = await listInstalledSkills();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { skills: Array<{ skillId: string; version: string }> };
    const listed = body.skills.find((skill) => skill.skillId === SKILL_ID);

    expect(listed?.version).toBe(TO_VERSION);
    // No update affordance: the served version is the Catalog's latest.
    expect(hasSkillUpdate(listed!.version, TO_VERSION)).toBe(false);
    // And the row itself converged, so the dashboard scan sees it too.
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)?.version).toBe(TO_VERSION);
  });

  it('names both versions when a client asks for the version already installed', async () => {
    await driftIndexBehindDisk();

    // What a client reading the stale list would have sent.
    const response = await requestUpdatePlan({ version: TO_VERSION });

    expect(response.status).toBe(404);
    const body = (await response.json()) as { code: string; error: string };
    expect(body.code).toBe('SKILL_UPDATE_VERSION_NOT_ELIGIBLE');
    expect(body.error).toContain(`requested version ${TO_VERSION}`);
    expect(body.error).toContain(`receipt on disk records ${TO_VERSION}`);
  });

  it('converges without touching the payload or the operation log', async () => {
    await driftIndexBehindDisk();
    const before = snapshotTree(worktreeDir);
    const auditBefore = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID }).length;

    expect((await listInstalledSkills()).status).toBe(200);

    expect(treeDelta(before, snapshotTree(worktreeDir))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
    expect(listSkillOperationAudit(db, { worktreeId: WORKTREE_ID })).toHaveLength(auditBefore);
  });
});

// =============================================================================
// Idempotency
// =============================================================================

describe('Skill update: retried requests', () => {
  it('answers a retry from the recorded outcome instead of switching twice', async () => {
    const plan = await updatePlanOrThrow();
    const key = 'update-retry-key-1';

    const first = await applyPlan(plan, { idempotencyKey: key });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as Record<string, never>;
    expect((firstBody.operation as Record<string, unknown>).replayed).toBe(false);

    // The same request delivered twice: the token is already gone, so without
    // the journal this would look like a replay attack rather than a retry.
    const second = await requestUpdate({
      planToken: plan.token,
      version: plan.update.toVersion,
      idempotencyKey: key,
    });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as Record<string, never>;
    expect((secondBody.operation as Record<string, unknown>).replayed).toBe(true);
    expect((secondBody.update as Record<string, string>).version).toBe(TO_VERSION);

    // One switch, one audit row.
    expect(
      listSkillOperationAudit(db, { worktreeId: WORKTREE_ID, skillId: SKILL_ID }).filter(
        (row) => row.operation === 'update'
      )
    ).toHaveLength(1);
    expect(installedReceiptVersion()).toBe(TO_VERSION);
  });
});
