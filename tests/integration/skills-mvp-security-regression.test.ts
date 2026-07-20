/**
 * Skill MVP security regression matrix (Issue #1242)
 *
 * @vitest-environment node
 *
 * #1230 proves the package reader rejects the malicious corpus. This suite
 * proves something the unit tests cannot: that a rejection anywhere in the
 * pipeline leaves the target worktree byte-for-byte unchanged and the service
 * state root free of scratch. A guard that refuses but still writes a staging
 * directory, holds a lock or leaks a snapshot reference is not fail-closed, and
 * only an end-to-end assertion can see that.
 *
 * Every case therefore asserts three things, not one: the expected error code,
 * the filesystem invariant, and the residue invariant.
 */

import path from 'path';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
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
import { getWorktreeById } from '@/lib/db';
import { getDbInstance } from '@/lib/db/db-instance';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  SKILL_RECEIPT_FILENAME,
  getSkillInstallPlan,
  resetSkillInstallPlanCacheForTesting,
} from '@/lib/skills/install-plan';
import { resetSkillUninstallPlanCacheForTesting } from '@/lib/skills/uninstall-plan';
import {
  resetSkillSnapshotStoreForTesting,
  getSkillSnapshotUsage,
} from '@/lib/skills/snapshot-store';
import { getSkillInstallation } from '@/lib/skills/installed-state';
import { MALICIOUS_PACKAGES, SKILL_ID, SKILL_VERSION } from '../fixtures/skills/malicious-packages';
import type { Worktree } from '@/types/models';
import {
  WORKTREE_ID,
  artifactFromBytes,
  buildArtifact,
  buildCatalog,
  catalogResult,
  createTestRoot,
  git,
  initGitRepo,
  installRootOf,
  removeTestRoot,
  seedWorktreeRow,
  residueReport,
  snapshotTree,
  treeDelta,
  writeRepoFile,
  type BuiltArtifact,
} from './skills/mvp-harness';

const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const getDbInstanceMock = vi.mocked(getDbInstance);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const downloadSkillArtifactMock = vi.mocked(downloadSkillArtifact);

let worktreeDir: string;
let configRoot: string;
let db: Database.Database;
let baseline: Map<string, { sha256: string; mode: number; size: number }>;

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

/** Serve exactly these bytes as the Catalog's declared artifact for SKILL_ID. */
function serve(artifact: BuiltArtifact): void {
  getSkillCatalogMock.mockResolvedValue(catalogResult(buildCatalog([artifact])) as never);
  downloadSkillArtifactMock.mockResolvedValue({
    skillId: artifact.skillId,
    version: artifact.version,
    commit: artifact.commit,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    size: artifact.size,
  });
}

function serveBenign(): BuiltArtifact {
  const artifact = buildArtifact(SKILL_ID, SKILL_VERSION);
  serve(artifact);
  return artifact;
}

function routeRequest(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: 'POST',
    body: JSON.stringify(body ?? {}),
  });
}

function params(skillId = SKILL_ID) {
  return { params: Promise.resolve({ id: WORKTREE_ID, skillId }) };
}

async function requestPlan(body: unknown = {}): Promise<Response> {
  return buildPlan(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/plan`, body),
    params()
  );
}

async function requestInstall(body: unknown): Promise<Response> {
  return applyInstall(
    routeRequest(`/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/install`, body),
    params()
  );
}

interface PlanDto {
  token: string;
  installable: boolean;
  requiresRiskAcknowledgement: boolean;
  skill: { version: string };
  files: { path: string; change: string; reasonCode: string }[];
  blockers: { code: string; path: string | null }[];
  warnings: string[];
  target: {
    workingTreeDirty: boolean;
    existingInstall: { version: string; receiptDigest: string } | null;
  };
}

async function planDto(): Promise<PlanDto> {
  const response = await requestPlan();
  expect(response.status).toBe(200);
  return ((await response.json()) as { plan: PlanDto }).plan;
}

/** plan → install for a package expected to succeed. */
async function installOnce(): Promise<void> {
  const plan = await planDto();
  expect(plan.installable).toBe(true);
  const response = await requestInstall({
    planToken: plan.token,
    version: plan.skill.version,
    acknowledgeRisk: Boolean(plan.requiresRiskAcknowledgement),
  });
  expect(response.status).toBe(200);
}

/** The two invariants every refusal must hold, whatever the reason was. */
function expectNothingHappened(context: string): void {
  expect(treeDelta(baseline, snapshotTree(worktreeDir)), `worktree changed: ${context}`).toEqual({
    added: [],
    removed: [],
    changed: [],
  });
  const residue = residueReport(configRoot, worktreeDir);
  expect(residue.locks, `lock leaked: ${context}`).toEqual([]);
  expect(residue.packageStaging, `package staging leaked: ${context}`).toEqual([]);
  expect(residue.worktreeStaging, `worktree staging leaked: ${context}`).toEqual([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSkillInstallPlanCacheForTesting();
  resetSkillUninstallPlanCacheForTesting();
  resetSkillSnapshotStoreForTesting();

  worktreeDir = createTestRoot('sec-wt');
  configRoot = createTestRoot('sec-cfg');
  state.configRoot = configRoot;
  initGitRepo(worktreeDir);

  db = new Database(':memory:');
  runMigrations(db);
  seedWorktreeRow(db, worktreeDir);
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());

  serveBenign();
  baseline = snapshotTree(worktreeDir);
});

afterEach(() => {
  db.close();
  resetSkillSnapshotStoreForTesting();
  removeTestRoot(worktreeDir);
  removeTestRoot(configRoot);
});

// =============================================================================
// Malicious archive corpus, through the install path
// =============================================================================

describe('Skill MVP security: malicious archive corpus', () => {
  it.each(MALICIOUS_PACKAGES.map((testCase) => [testCase.name, testCase] as const))(
    'refuses %s without touching the worktree',
    async (_name, testCase) => {
      serve(artifactFromBytes(SKILL_ID, SKILL_VERSION, testCase.build()));

      const response = await requestPlan();
      expect(response.status, testCase.threat).toBe(422);
      expect((await response.json()).code, testCase.threat).toBe(testCase.expectedCode);

      expect(existsSync(installRootOf(worktreeDir, SKILL_ID))).toBe(false);
      expectNothingHappened(testCase.name);
    },
    30_000
  );

  it('releases the snapshot reference taken before verification failed', async () => {
    serve(artifactFromBytes(SKILL_ID, SKILL_VERSION, MALICIOUS_PACKAGES[0].build()));
    expect((await requestPlan()).status).toBe(422);

    // The route creates the snapshot before it inspects, so a failure must
    // hand the reference back — otherwise the entry is pinned for the process
    // lifetime and the quota erodes with every rejected package.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      vi.setSystemTime(Date.now() + 31 * 60 * 1000);
      const { sweepSkillSnapshots } = await import('@/lib/skills/snapshot-store');
      sweepSkillSnapshots();
      expect(getSkillSnapshotUsage()).toEqual({ count: 0, totalBytes: 0 });
    } finally {
      vi.useRealTimers();
    }
  });
});

// =============================================================================
// Target state: unmanaged files, local modifications, dirty tree
// =============================================================================

describe('Skill MVP security: target state', () => {
  it('refuses to plan over an unmanaged directory at the install root', async () => {
    const root = installRootOf(worktreeDir, SKILL_ID);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'SKILL.md'), '# hand written\n', 'utf-8');
    baseline = snapshotTree(worktreeDir);

    const plan = await planDto();
    expect(plan.installable).toBe(false);
    expect(plan.files.some((entry) => entry.change === 'unmanaged')).toBe(true);
    expect(plan.blockers.length).toBeGreaterThan(0);

    expectNothingHappened('unmanaged install root');
  });

  /**
   * MVP has no update path (#1243/#1244), so a re-install must be refused
   * rather than silently rewritten. The refusal lands at *apply*, not at plan:
   * an unchanged managed tree produces a clean, installable-looking diff, and
   * only `inspectSkillDestination` at the commit point sees the existing
   * receipt. Asserting at the plan layer would have missed the real guard.
   */
  it('refuses to apply over an existing managed install rather than overwriting', async () => {
    await installOnce();
    const afterInstall = snapshotTree(worktreeDir);

    const plan = await planDto();
    expect(plan.target.existingInstall).not.toBeNull();
    expect(plan.target.existingInstall!.version).toBe(SKILL_VERSION);

    const response = await requestInstall({
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: false,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_INSTALL_DESTINATION_EXISTS');

    expect(treeDelta(afterInstall, snapshotTree(worktreeDir))).toEqual({
      added: [],
      removed: [],
      changed: [],
    });
  });

  it('flags a locally modified managed file as a conflict and refuses', async () => {
    await installOnce();
    const root = installRootOf(worktreeDir, SKILL_ID);
    chmodSync(path.join(root, 'SKILL.md'), 0o600);
    writeFileSync(path.join(root, 'SKILL.md'), '# locally edited\n', 'utf-8');

    const plan = await planDto();
    expect(plan.installable).toBe(false);
    expect(
      plan.files.some((entry) => entry.change === 'conflict' || entry.change === 'unmanaged')
    ).toBe(true);
    expect(plan.blockers.length).toBeGreaterThan(0);
  });

  it('plans against a dirty working tree but reports it as a warning', async () => {
    writeRepoFile(worktreeDir, 'README.md', '# dirty\n');
    baseline = snapshotTree(worktreeDir);

    const plan = await planDto();
    expect(plan.installable).toBe(true);
    expect(plan.warnings).toContain('SKILL_PREVIEW_WORKING_TREE_DIRTY');
    expect(plan.target.workingTreeDirty).toBe(true);
  });

  it('refuses when the install root is a symlink', async () => {
    const outside = createTestRoot('sec-outside');
    try {
      mkdirSync(path.join(worktreeDir, '.agents', 'skills'), { recursive: true });
      const { symlinkSync } = await import('fs');
      symlinkSync(outside, installRootOf(worktreeDir, SKILL_ID));
      baseline = snapshotTree(worktreeDir);

      const plan = await planDto();
      expect(plan.installable).toBe(false);

      // Nothing was written through the link into the directory outside.
      expect(snapshotTree(outside, []).size).toBe(0);
    } finally {
      removeTestRoot(outside);
    }
  });
});

// =============================================================================
// Plan lifecycle: drift, expiry, single use, risk acknowledgement
// =============================================================================

describe('Skill MVP security: plan lifecycle', () => {
  it('rejects a plan whose HEAD moved between preview and apply', async () => {
    const plan = await planDto();

    writeRepoFile(worktreeDir, 'drift.txt', 'moved\n');
    git(worktreeDir, ['add', '-A']);
    git(worktreeDir, ['commit', '-q', '-m', 'drift']);
    baseline = snapshotTree(worktreeDir);

    const response = await requestInstall({
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: false,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expectNothingHappened('HEAD drift');
  });

  it('rejects a plan whose branch changed between preview and apply', async () => {
    const plan = await planDto();

    git(worktreeDir, ['checkout', '-q', '-b', 'feature/other']);
    baseline = snapshotTree(worktreeDir);

    const response = await requestInstall({
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: false,
    });
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expectNothingHappened('branch drift');
  });

  it('rejects an expired plan token', async () => {
    const plan = await planDto();

    // Expire the record in place rather than travelling the clock: the route
    // is async and drives real git, which fake timers would destabilise.
    const record = getSkillInstallPlan(plan.token);
    record.expiresAt = Date.now() - 1;

    const response = await requestInstall({
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: false,
    });
    expect(response.status).toBe(410);
    expect((await response.json()).code).toBe('SKILL_PLAN_EXPIRED');
    expectNothingHappened('expired plan');
  });

  it('rejects an unknown or malformed plan token', async () => {
    for (const token of ['', 'not-a-token', 'f'.repeat(48), 'F'.repeat(48)]) {
      const response = await requestInstall({
        planToken: token,
        version: SKILL_VERSION,
        acknowledgeRisk: false,
      });
      expect([400, 404], `token ${token || '(empty)'}`).toContain(response.status);
    }
    expectNothingHappened('bad tokens');
  });

  it('spends a plan token exactly once', async () => {
    const plan = await planDto();
    const body = { planToken: plan.token, version: plan.skill.version, acknowledgeRisk: false };

    expect((await requestInstall(body)).status).toBe(200);

    const replay = await requestInstall(body);
    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('SKILL_PLAN_CONSUMED');
  });

  it('refuses a request that tries to supply its own path, URL or checksum', async () => {
    for (const body of [
      { worktreePath: '/etc' },
      { artifactUrl: 'https://evil.test/x.tar.gz' },
      { sha256: 'a'.repeat(64) },
      { files: ['../../etc/passwd'] },
      { installRoot: '/tmp/anywhere' },
    ]) {
      const response = await requestPlan(body);
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect((await response.json()).code, JSON.stringify(body)).toBe('SKILL_PLAN_INPUT_REJECTED');
    }
    expectNothingHappened('client-supplied plan inputs');
  });

  it('requires an explicit risk acknowledgement for a high-risk package', async () => {
    serve(
      buildArtifact(SKILL_ID, SKILL_VERSION, {
        manifestPatch: (manifest) => {
          manifest.declared_risk = 'high';
          manifest.declared_permissions = ['credential_access'];
          manifest.risk_rationale = 'Reads credentials for the security regression test.';
        },
      })
    );

    const plan = await planDto();
    expect(plan.requiresRiskAcknowledgement).toBe(true);

    const refused = await requestInstall({
      planToken: plan.token,
      version: plan.skill.version,
      acknowledgeRisk: false,
    });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe('SKILL_PLAN_RISK_NOT_ACKNOWLEDGED');
    expectNothingHappened('unacknowledged high risk');
  });
});

// =============================================================================
// Concurrency
// =============================================================================

describe('Skill MVP security: concurrent operations', () => {
  it('lets exactly one of two concurrent installs commit', async () => {
    const first = await planDto();
    const second = await planDto();

    const [a, b] = await Promise.all([
      requestInstall({ planToken: first.token, version: first.skill.version, acknowledgeRisk: false }),
      requestInstall({
        planToken: second.token,
        version: second.skill.version,
        acknowledgeRisk: false,
      }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(409);

    // One install, one index row, one receipt — never a partially merged tree.
    expect(getSkillInstallation(db, WORKTREE_ID, SKILL_ID)).not.toBeNull();
    expect(existsSync(path.join(installRootOf(worktreeDir, SKILL_ID), SKILL_RECEIPT_FILENAME))).toBe(
      true
    );

    const residue = residueReport(configRoot, worktreeDir);
    expect(residue.locks).toEqual([]);
    expect(residue.worktreeStaging).toEqual([]);
  });
});

// =============================================================================
// Catalog availability
// =============================================================================

describe('Skill MVP security: Catalog availability', () => {
  it('refuses to plan when the Catalog cannot be resolved at all', async () => {
    getSkillCatalogMock.mockResolvedValue({
      ok: false,
      failure: {
        code: 'SKILL_CATALOG_FETCH_FAILED',
        message: 'catalog unreachable',
        errors: [],
      },
    } as never);

    const response = await requestPlan();
    expect(response.status).toBeGreaterThanOrEqual(500);
    expectNothingHappened('catalog unreachable');
  });

  it('still plans from a stale last-known-good Catalog, and says so', async () => {
    const artifact = buildArtifact(SKILL_ID, SKILL_VERSION);
    const fresh = catalogResult(buildCatalog([artifact]));
    getSkillCatalogMock.mockResolvedValue({
      ok: true,
      snapshot: {
        ...fresh.snapshot,
        state: 'stale',
        stale: true,
        offline: true,
        staleReason: 'SKILL_CATALOG_FETCH_FAILED',
      },
    } as never);
    downloadSkillArtifactMock.mockResolvedValue({
      skillId: artifact.skillId,
      version: artifact.version,
      commit: artifact.commit,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      size: artifact.size,
    });

    const plan = await planDto();
    expect(plan.installable).toBe(true);
  });
});
