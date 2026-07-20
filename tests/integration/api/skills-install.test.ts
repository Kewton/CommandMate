/**
 * API integration tests — Install apply route (Issue #1235)
 *
 * Runs the real vertical slice: the plan route issues a token against a real
 * temporary worktree and a real `tar.gz` package, and the install route spends
 * it, writes the payload and records the operation in a real database. Only the
 * network edges are mocked — the Catalog, the artifact download and the snapshot
 * store — because `Kewton/commandmate-skills` is private and an install must
 * never re-fetch anything at apply time anyway.
 *
 * What each case is really checking is that a rejection leaves the worktree
 * exactly as it was, and that a success leaves precisely the bytes the plan
 * previewed.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
import type { SkillCatalog, SkillManifest } from '@/types/skills';
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

import { POST as buildPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
import { POST as applyInstall } from '@/app/api/worktrees/[id]/skills/[skillId]/install/route';
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
import { resetSkillInstallPlanCacheForTesting } from '@/lib/skills/install-plan';
import { SKILL_RECEIPT_FILENAME } from '@/lib/skills/install-plan';
import { getSkillInstallation } from '@/lib/skills/installed-state';
import { listSkillOperationAudit } from '@/lib/skills/operation-audit';
import { runMigrations } from '@/lib/db/db-migrations';
import { getSkillInstallStagingRoot } from '@/lib/skills/operation-store';
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

function useArtifact(options: {
  files?: PackageFileSpec[];
  manifestPatch?: (manifest: SkillManifest) => void;
} = {}): void {
  const built = buildPackage({
    skillId: SKILL_ID,
    version: VERSION,
    ...(options.files ? { files: options.files } : {}),
    ...(options.manifestPatch ? { manifestPatch: options.manifestPatch } : {}),
  });
  artifact = built.bytes;
  artifactSha = createHash('sha256').update(artifact).digest('hex');
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

function setHead(commit: string | null): void {
  execGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'feature/demo';
    if (args[0] === 'rev-parse') return commit;
    if (args[0] === 'status') return '';
    return null;
  });
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

async function requestPlan(body: Record<string, unknown> = {}): Promise<Response> {
  return buildPlan(
    new NextRequest(`http://localhost/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/plan`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: WORKTREE_ID, skillId: SKILL_ID }) }
  );
}

async function requestInstall(body: Record<string, unknown>): Promise<Response> {
  return applyInstall(
    new NextRequest(`http://localhost/api/worktrees/${WORKTREE_ID}/skills/${SKILL_ID}/install`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: WORKTREE_ID, skillId: SKILL_ID }) }
  );
}

/** Build a plan and hand back its token together with the previewed payload. */
async function issuePlan(body: Record<string, unknown> = {}): Promise<{
  token: string;
  plan: { receipt: { sha256: string; size: number }; files: Array<{ path: string }> };
}> {
  const response = await requestPlan(body);
  expect(response.status).toBe(200);
  const payload = await response.json();
  return { token: payload.plan.token, plan: payload.plan };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSkillInstallPlanCacheForTesting();

  worktreeDir = mkdtempSync(path.join(tmpdir(), 'cm-install-wt-'));
  configRoot = mkdtempSync(path.join(tmpdir(), 'cm-install-cfg-'));
  state.configRoot = configRoot;

  db = new Database(':memory:');
  runMigrations(db);
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());

  useArtifact();
  wireMocks();
  setHead(HEAD);
  execFileAsyncMock.mockResolvedValue({ stdout: '', stderr: '' });
});

afterEach(() => {
  db.close();
  rmSync(worktreeDir, { recursive: true, force: true });
  rmSync(configRoot, { recursive: true, force: true });
});

// =============================================================================
// Cases
// =============================================================================

describe('POST /api/worktrees/[id]/skills/[skillId]/install — success', () => {
  it('writes the payload the plan previewed, byte for byte', async () => {
    const { token, plan } = await issuePlan();

    const response = await requestInstall({ planToken: token, version: VERSION });
    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.operation).toMatchObject({
      state: 'SUCCEEDED',
      result: 'succeeded',
      committed: true,
      reconcilePending: false,
      replayed: false,
      nextActionKey: 'skills.install.nextAction.succeeded',
    });
    expect(payload.install.installRoot).toBe(`.agents/skills/${SKILL_ID}`);

    // The receipt on disk is the file the plan hashed, not one rebuilt at apply.
    const receiptBytes = readFileSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME));
    expect(createHash('sha256').update(receiptBytes).digest('hex')).toBe(plan.receipt.sha256);
    expect(receiptBytes.byteLength).toBe(plan.receipt.size);
    expect(payload.install.receipt.sha256).toBe(plan.receipt.sha256);

    for (const file of payload.install.files) {
      const bytes = readFileSync(path.join(installRootAbs(), file.path));
      expect(createHash('sha256').update(bytes).digest('hex')).toBe(file.sha256);
    }
    // Every planned path in the preview exists, and nothing else was created.
    const previewed = plan.files.map((entry) => entry.path).sort();
    expect(previewed).toContain(`.agents/skills/${SKILL_ID}/${SKILL_RECEIPT_FILENAME}`);
  });

  it('records the install in the index and appends one audit row', async () => {
    const { token } = await issuePlan();

    await requestInstall({ planToken: token, version: VERSION });

    const installation = getSkillInstallation(db, WORKTREE_ID, SKILL_ID);
    expect(installation).toMatchObject({
      version: VERSION,
      installRoot: `.agents/skills/${SKILL_ID}`,
      sourceCommit: COMMIT,
      artifactSha256: artifactSha,
    });

    const audit = listSkillOperationAudit(db, { worktreeId: WORKTREE_ID });
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ operation: 'install', result: 'succeeded', state: 'SUCCEEDED' });
  });

  it('returns per-agent reload guidance for the version that landed', async () => {
    const { token } = await issuePlan();

    const payload = await (await requestInstall({ planToken: token, version: VERSION })).json();

    expect(payload.reload).toMatchObject({ skillId: SKILL_ID, version: VERSION });
    expect(payload.reload.agents).toEqual([
      { agent: 'claude', support: 'native', messageKey: 'skills.install.reload.native' },
    ]);
  });

  it('leaves no staging directory in the worktree', async () => {
    const { token } = await issuePlan();

    await requestInstall({ planToken: token, version: VERSION });

    expect(existsSync(getSkillInstallStagingRoot(worktreeDir))).toBe(false);
    expect(readdirSync(path.join(worktreeDir, '.agents', 'skills'))).toEqual([SKILL_ID]);
  });

  it('does not execute a script the package ships', async () => {
    const sentinel = path.join(worktreeDir, 'script-was-executed');
    useArtifact({
      files: [
        { path: 'reference/notes.md', content: '# Notes\n' },
        {
          path: 'scripts/install.sh',
          content: `#!/bin/sh\ntouch ${sentinel}\n`,
          mode: 0o755,
          kind: 'script',
          script: true,
        },
      ],
    });
    wireMocks();

    const { token } = await issuePlan();
    // Shipping a script raises the computed risk, so the acknowledgement is
    // required — which is itself the guard this package would otherwise dodge.
    const response = await requestInstall({
      planToken: token,
      version: VERSION,
      acknowledgeRisk: true,
    });

    expect(response.status).toBe(200);
    expect(existsSync(path.join(installRootAbs(), 'scripts/install.sh'))).toBe(true);
    expect(existsSync(sentinel)).toBe(false);
  });

  it('does not re-download the artifact at apply time', async () => {
    const { token } = await issuePlan();
    downloadSkillArtifactMock.mockClear();

    await requestInstall({ planToken: token, version: VERSION });

    expect(downloadSkillArtifactMock).not.toHaveBeenCalled();
    expect(readSkillSnapshotBytesMock).toHaveBeenCalledWith(SNAPSHOT_ID);
  });
});

describe('POST …/install — the token contract', () => {
  it('refuses a second apply of the same token', async () => {
    const { token } = await issuePlan();
    expect((await requestInstall({ planToken: token, version: VERSION })).status).toBe(200);

    const replay = await requestInstall({ planToken: token, version: VERSION });

    expect(replay.status).toBe(409);
    expect((await replay.json()).code).toBe('SKILL_PLAN_CONSUMED');
  });

  it('refuses a token presented for a different version', async () => {
    const { token } = await issuePlan();

    const response = await requestInstall({ planToken: token, version: '9.9.9' });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_BINDING_MISMATCH');
    expect(existsSync(installRootAbs())).toBe(false);
  });

  it('refuses a plan whose target moved on', async () => {
    const { token } = await issuePlan();
    setHead('b'.repeat(40));

    const response = await requestInstall({ planToken: token, version: VERSION });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expect(existsSync(installRootAbs())).toBe(false);
  });

  it('refuses a plan whose destination tree changed since it was previewed', async () => {
    const { token } = await issuePlan();
    mkdirSync(installRootAbs(), { recursive: true });
    writeFileSync(path.join(installRootAbs(), 'SKILL.md'), 'appeared after the preview\n');

    const response = await requestInstall({ planToken: token, version: VERSION });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_STALE');
    expect(readFileSync(path.join(installRootAbs(), 'SKILL.md')).toString()).toBe(
      'appeared after the preview\n'
    );
  });

  it('refuses a malformed token before the plan store is consulted', async () => {
    const response = await requestInstall({ planToken: 'not-a-token', version: VERSION });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_INSTALL_INVALID_BODY');
  });

  it('refuses an unknown token', async () => {
    const response = await requestInstall({ planToken: 'a'.repeat(48), version: VERSION });

    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('SKILL_PLAN_NOT_FOUND');
  });
});

describe('POST …/install — risk acknowledgement', () => {
  beforeEach(() => {
    useArtifact({
      manifestPatch: (manifest) => {
        manifest.declared_risk = 'high';
      },
    });
    wireMocks();
  });

  it('cannot be skipped for a high-risk package', async () => {
    const { token } = await issuePlan();

    const response = await requestInstall({ planToken: token, version: VERSION });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_RISK_NOT_ACKNOWLEDGED');
    expect(existsSync(installRootAbs())).toBe(false);
  });

  it('proceeds once the risk is acknowledged explicitly', async () => {
    const { token } = await issuePlan();

    const response = await requestInstall({
      planToken: token,
      version: VERSION,
      acknowledgeRisk: true,
    });

    expect(response.status).toBe(200);
    expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);
  });
});

describe('POST …/install — what the client may not supply', () => {
  it.each(['path', 'installRoot', 'artifactUrl', 'files', 'sha256', 'snapshotId'])(
    'rejects a body carrying `%s` rather than ignoring it',
    async (key) => {
      const { token } = await issuePlan();

      const response = await requestInstall({
        planToken: token,
        version: VERSION,
        [key]: 'anything',
      });

      expect(response.status).toBe(400);
      expect((await response.json()).code).toBe('SKILL_PLAN_INPUT_REJECTED');
      expect(existsSync(installRootAbs())).toBe(false);
    }
  );

  it('rejects an unknown field', async () => {
    const { token } = await issuePlan();

    const response = await requestInstall({ planToken: token, version: VERSION, force: true });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_INSTALL_INVALID_BODY');
  });

  it('never echoes a machine-absolute path in an error body', async () => {
    mkdirSync(installRootAbs(), { recursive: true });
    const { token } = await issuePlan();
    const response = await requestInstall({ planToken: token, version: VERSION });

    const body = JSON.stringify(await response.json());
    expect(body).not.toContain(worktreeDir);
    expect(body).not.toContain(tmpdir());
  });
});

describe('POST …/install — an occupied destination', () => {
  it('refuses to overwrite an unmanaged Skill directory', async () => {
    mkdirSync(installRootAbs(), { recursive: true });
    writeFileSync(path.join(installRootAbs(), 'SKILL.md'), 'hand-written\n');

    const { token } = await issuePlan();
    const response = await requestInstall({ planToken: token, version: VERSION });

    // The plan already knows this destination is not installable, so the token
    // is refused before anything is staged.
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_PLAN_NOT_INSTALLABLE');
    expect(readFileSync(path.join(installRootAbs(), 'SKILL.md')).toString()).toBe('hand-written\n');
  });

  it('refuses to publish into an empty directory that appeared at the install root', async () => {
    mkdirSync(installRootAbs(), { recursive: true });

    const { token } = await issuePlan();
    const response = await requestInstall({ planToken: token, version: VERSION });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_INSTALL_DESTINATION_UNMANAGED');
    expect(readdirSync(installRootAbs())).toEqual([]);
  });

  it('refuses a second install of the same Skill into the same worktree', async () => {
    const first = await issuePlan();
    expect((await requestInstall({ planToken: first.token, version: VERSION })).status).toBe(200);

    const second = await issuePlan();
    const response = await requestInstall({ planToken: second.token, version: VERSION });

    // Updating an existing install is out of scope; the receipt already there
    // must not be silently replaced.
    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_INSTALL_DESTINATION_EXISTS');
  });
});

describe('POST …/install — idempotency', () => {
  it('replays a recorded success instead of spending a second token', async () => {
    const { token } = await issuePlan();
    const key = 'install-demo-skill-0001';
    expect(
      (await requestInstall({ planToken: token, version: VERSION, idempotencyKey: key })).status
    ).toBe(200);

    const { token: second } = await issuePlan();
    const replay = await requestInstall({
      planToken: second,
      version: VERSION,
      idempotencyKey: key,
    });

    expect(replay.status).toBe(200);
    const payload = await replay.json();
    expect(payload.operation).toMatchObject({ replayed: true, state: 'SUCCEEDED' });
    expect(payload.install).toMatchObject({ skillId: SKILL_ID, version: VERSION });
    // The replay must not have installed a second time.
    expect(listSkillOperationAudit(db, { worktreeId: WORKTREE_ID })).toHaveLength(1);
  });

  it('refuses a key already used for a different target', async () => {
    const { token } = await issuePlan();
    const key = 'install-demo-skill-0002';
    await requestInstall({ planToken: token, version: VERSION, idempotencyKey: key });

    const { token: second } = await issuePlan();
    const response = await requestInstall({
      planToken: second,
      version: '9.9.9',
      idempotencyKey: key,
    });

    expect(response.status).toBe(409);
    expect((await response.json()).code).toBe('SKILL_INSTALL_IDEMPOTENCY_CONFLICT');
  });

  it('rejects a key that is not a safe identifier', async () => {
    const { token } = await issuePlan();

    const response = await requestInstall({
      planToken: token,
      version: VERSION,
      idempotencyKey: '../../etc/passwd',
    });

    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_INSTALL_INVALID_BODY');
  });
});

describe('POST …/install — a failure after the commit point', () => {
  it('reports the payload as committed and reconciling, not as unchanged', async () => {
    const { token } = await issuePlan();

    // The index write is the first thing that happens after the atomic rename.
    const realPrepare = db.prepare.bind(db);
    vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
      if (sql.includes('INSERT INTO skill_installations')) {
        throw new Error(`disk I/O error while writing ${worktreeDir}`);
      }
      return realPrepare(sql);
    });

    const response = await requestInstall({ planToken: token, version: VERSION });

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.operation).toMatchObject({
      state: 'FAILED_RECONCILABLE',
      result: 'committed_reconciling',
      committed: true,
      reconcilePending: true,
      nextActionKey: 'skills.install.nextAction.committedReconciling',
    });
    // The payload really is on disk, which is why "unchanged" would be a lie.
    expect(existsSync(path.join(installRootAbs(), SKILL_RECEIPT_FILENAME))).toBe(true);
    expect(JSON.stringify(payload)).not.toContain(worktreeDir);
  });
});
