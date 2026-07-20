/**
 * API integration tests — Install Plan route (Issue #1233)
 *
 * What is under test is the input contract. The route accepts a worktree ID and
 * a version, and nothing else: a body that names a path, a URL, a file list or
 * a checksum must be rejected rather than quietly ignored, because an ignored
 * field looks to a caller like an unsupported spelling worth retrying.
 *
 * Nothing here touches the network or a real repository: the Catalog, the
 * artifact download, the snapshot store, the package reader and git are all
 * mocked.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';
import { createHash } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { SkillCatalog } from '@/types/skills';
import type { SkillCatalogResult } from '@/lib/skills/catalog-client';
import type { SkillPackageSnapshot } from '@/lib/skills/package-validator';

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

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn() }));
vi.mock('@/lib/skills/catalog-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skills/catalog-client')>();
  return { ...actual, getSkillCatalog: vi.fn() };
});
vi.mock('@/lib/skills/artifact-downloader', () => ({ downloadSkillArtifact: vi.fn() }));
vi.mock('@/lib/skills/snapshot-store', () => ({
  initSkillSnapshotStore: vi.fn(() => '/tmp/snapshots'),
  createSkillSnapshot: vi.fn(),
  releaseSkillSnapshot: vi.fn(),
}));
vi.mock('@/lib/skills/package-validator', () => ({ inspectSkillPackage: vi.fn() }));
vi.mock('@/lib/version-checker', () => ({ getServerVersion: vi.fn(() => '0.11.4') }));
vi.mock('@/lib/git/git-exec', () => ({
  execGitCommand: vi.fn(),
  execFileAsync: vi.fn(),
}));

import { POST as buildPlan } from '@/app/api/worktrees/[id]/skills/[skillId]/plan/route';
import { getWorktreeById } from '@/lib/db';
import { getSkillCatalog } from '@/lib/skills/catalog-client';
import { downloadSkillArtifact } from '@/lib/skills/artifact-downloader';
import { createSkillSnapshot, releaseSkillSnapshot } from '@/lib/skills/snapshot-store';
import { inspectSkillPackage } from '@/lib/skills/package-validator';
import { execGitCommand, execFileAsync } from '@/lib/git/git-exec';
import { SkillFetchError, SkillFetchErrorCode } from '@/lib/skills/integrity';
import { SkillPackageError, SkillPackageErrorCode } from '@/lib/skills/package-reader';
import { resetSkillInstallPlanCacheForTesting } from '@/lib/skills/install-plan';
import type { Worktree } from '@/types/models';

const getWorktreeByIdMock = vi.mocked(getWorktreeById);
const getSkillCatalogMock = vi.mocked(getSkillCatalog);
const downloadSkillArtifactMock = vi.mocked(downloadSkillArtifact);
const createSkillSnapshotMock = vi.mocked(createSkillSnapshot);
const releaseSkillSnapshotMock = vi.mocked(releaseSkillSnapshot);
const inspectSkillPackageMock = vi.mocked(inspectSkillPackage);
const execGitCommandMock = vi.mocked(execGitCommand);
const execFileAsyncMock = vi.mocked(execFileAsync) as unknown as ReturnType<typeof vi.fn>;

const SKILL_ID = 'release-notes';
const COMMIT = '7dba1ec2e66342ef578ab57bbdaa9b4327897d47';
const ARTIFACT_SHA = '4bdb91f46683de4df48783d57b75248f7c7e8c34619e5cbb090ba69a6c781c21';
const SKILL_MD = Buffer.from('# release-notes\n', 'utf-8');

let worktreeDir: string;

function makeCatalog(commandmate = '>=0.11.0 <1.0.0'): SkillCatalog {
  return {
    schema_version: 1,
    entries: [
      {
        id: SKILL_ID,
        name: SKILL_ID,
        summary: 'Draft release notes from merged pull requests.',
        provider: { name: 'CommandMate' },
        license: 'MIT',
        latest: '1.2.0',
        versions: [
          {
            version: '1.2.0',
            changelog: 'Release 1.2.0',
            published_at: '2026-07-16T09:30:00Z',
            source: { repository: 'Kewton/commandmate-skills', ref: 'v1.2.0', commit: COMMIT },
            artifact: {
              asset_name: 'release-notes-1.2.0.tar.gz',
              url: 'https://example.invalid/release-notes-1.2.0.tar.gz',
              sha256: ARTIFACT_SHA,
              size: 4096,
              content_type: 'application/gzip',
              format: 'tar.gz',
            },
            compatibility: { commandmate, agents: [] },
            declared_risk: 'low',
          },
        ],
      },
    ],
  };
}

function catalogResult(catalog = makeCatalog()): SkillCatalogResult {
  return {
    ok: true,
    snapshot: {
      catalog,
      fetchedAt: '2026-07-16T10:00:00Z',
      revalidatedAt: '2026-07-16T10:00:00Z',
      stale: false,
      offline: false,
      state: 'fresh',
      staleReason: null,
      source: { repository: 'Kewton/commandmate-skills', ref: 'main', revision: null },
    },
  } as SkillCatalogResult;
}

function makeSnapshot(): SkillPackageSnapshot {
  const sha = createHash('sha256').update(SKILL_MD).digest('hex');
  return {
    skillId: SKILL_ID,
    version: '1.2.0',
    manifest: {
      schema_version: 1,
      id: SKILL_ID,
      name: SKILL_ID,
      version: '1.2.0',
      summary: 'Draft release notes.',
      description: 'Demo.',
      capabilities: ['Draft release notes.'],
      expected_outcomes: ['A reviewable draft.'],
      provider: { name: 'CommandMate' },
      license: 'MIT',
      compatibility: { commandmate: '>=0.11.0', agents: [] },
      requirements: { commands: [], network_hosts: [] },
      declared_permissions: ['filesystem_read'],
      declared_risk: 'low',
      risk_rationale: 'Reads only.',
      files: [
        { path: 'SKILL.md', sha256: sha, size: SKILL_MD.byteLength, kind: 'skill_md', executable: false, script: false },
      ],
    },
    files: [{ path: 'SKILL.md', sha256: sha, size: SKILL_MD.byteLength, executable: false }],
    directories: [],
    inspection: {
      executable_paths: [],
      script_paths: [],
      network_hosts: [],
      declared_permissions: ['filesystem_read'],
    },
    declaredRisk: 'low',
    computedRisk: 'low',
    effectiveRisk: 'low',
    readFile: () => new Uint8Array(SKILL_MD),
  };
}

function makeWorktree(): Worktree {
  return {
    id: 'demo-wt',
    name: 'feature/demo',
    path: worktreeDir,
    repositoryPath: '/srv/repos/CommandMate',
    repositoryName: 'CommandMate',
    branch: 'feature/demo',
  };
}

function request(body?: unknown, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost:3000/api/worktrees/demo-wt/skills/release-notes/plan', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function call(
  body?: unknown,
  params: { id: string; skillId: string } = { id: 'demo-wt', skillId: SKILL_ID },
  headers: Record<string, string> = {}
) {
  return buildPlan(request(body, headers), { params: Promise.resolve(params) });
}

beforeEach(() => {
  worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-plan-api-'));
  resetSkillInstallPlanCacheForTesting();
  vi.clearAllMocks();

  getWorktreeByIdMock.mockReturnValue(makeWorktree());
  getSkillCatalogMock.mockResolvedValue(catalogResult());
  downloadSkillArtifactMock.mockResolvedValue({
    bytes: Buffer.from('artifact'),
    sha256: ARTIFACT_SHA,
    size: 8,
    skillId: SKILL_ID,
    version: '1.2.0',
    commit: COMMIT,
  });
  createSkillSnapshotMock.mockReturnValue({
    snapshotId: 'a'.repeat(32),
    skillId: SKILL_ID,
    version: '1.2.0',
    commit: COMMIT,
    sha256: ARTIFACT_SHA,
    size: 8,
    expiresAt: Date.now() + 60_000,
  });
  inspectSkillPackageMock.mockReturnValue(makeSnapshot());
  execGitCommandMock.mockImplementation(async (args: string[]) => {
    if (args[0] === 'symbolic-ref') return 'feature/demo';
    if (args[0] === 'rev-parse') return 'b'.repeat(40);
    if (args[0] === 'status') return '';
    return null;
  });
  execFileAsyncMock.mockRejectedValue(Object.assign(new Error('exit 1'), { stdout: '' }));
});

describe('POST /api/worktrees/[id]/skills/[skillId]/plan', () => {
  it('builds a plan bound to the resolved worktree', async () => {
    const response = await call();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.plan.token).toMatch(/^[0-9a-f]{48}$/);
    expect(body.plan.target).toMatchObject({
      worktreeId: 'demo-wt',
      branch: 'feature/demo',
      headState: 'attached',
      installRoot: `.agents/skills/${SKILL_ID}`,
    });
    expect(body.plan.installable).toBe(true);
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('resolves the worktree path from the database, never from the request', async () => {
    await call();
    expect(getWorktreeByIdMock).toHaveBeenCalledWith(expect.anything(), 'demo-wt');
    expect(downloadSkillArtifactMock).toHaveBeenCalledWith(
      SKILL_ID,
      expect.objectContaining({ version: '1.2.0' })
    );
  });

  it('leaks no absolute path or artifact URL into the response', async () => {
    const text = await (await call()).text();
    expect(text).not.toContain(worktreeDir);
    expect(text).not.toContain('https://example.invalid');
  });

  it.each([
    ['worktreePath', { worktreePath: '/etc' }],
    ['path', { path: '/etc/passwd' }],
    ['installRoot', { installRoot: '../../etc' }],
    ['url', { url: 'https://evil.invalid/a.tar.gz' }],
    ['artifact', { artifact: { sha256: 'x' } }],
    ['files', { files: [{ path: 'a', sha256: 'b' }] }],
    ['sha256', { sha256: ARTIFACT_SHA }],
    ['snapshotId', { snapshotId: 'a'.repeat(32) }],
  ])('rejects a body carrying %s', async (_label, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_PLAN_INPUT_REJECTED');
    expect(downloadSkillArtifactMock).not.toHaveBeenCalled();
  });

  it('rejects an unknown body field rather than ignoring it', async () => {
    const response = await call({ nope: true });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_PLAN_INVALID_BODY');
  });

  it('rejects a malformed JSON body', async () => {
    const raw = new NextRequest(
      'http://localhost:3000/api/worktrees/demo-wt/skills/release-notes/plan',
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{oops' }
    );
    const response = await buildPlan(raw, {
      params: Promise.resolve({ id: 'demo-wt', skillId: SKILL_ID }),
    });
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('SKILL_PLAN_INVALID_BODY');
  });

  it('accepts an empty body and falls back to the recommended version', async () => {
    const response = await buildPlan(
      new NextRequest('http://localhost:3000/api/worktrees/demo-wt/skills/release-notes/plan', {
        method: 'POST',
      }),
      { params: Promise.resolve({ id: 'demo-wt', skillId: SKILL_ID }) }
    );
    expect(response.status).toBe(200);
    expect((await response.json()).plan.skill.version).toBe('1.2.0');
  });

  it('rejects an invalid worktree ID before any Catalog work', async () => {
    const response = await call(undefined, { id: '../etc', skillId: SKILL_ID });
    expect(response.status).toBe(400);
    expect(getSkillCatalogMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unregistered worktree', async () => {
    getWorktreeByIdMock.mockReturnValue(undefined as unknown as Worktree);
    expect((await call()).status).toBe(404);
  });

  it('rejects an invalid Skill ID', async () => {
    const response = await call(undefined, { id: 'demo-wt', skillId: 'Not/Valid' });
    expect(response.status).toBe(400);
    expect(getSkillCatalogMock).not.toHaveBeenCalled();
  });

  it('returns 404 for a Skill absent from the Catalog', async () => {
    const response = await call(undefined, { id: 'demo-wt', skillId: 'missing-skill' });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('SKILL_NOT_FOUND');
  });

  it('returns 404 for a version the Catalog does not publish', async () => {
    const response = await call({ version: '9.9.9' });
    expect(response.status).toBe(404);
    expect((await response.json()).code).toBe('SKILL_VERSION_NOT_FOUND');
  });

  it('returns 503 when the Catalog cannot be retrieved', async () => {
    getSkillCatalogMock.mockResolvedValue({
      ok: false,
      failure: { code: 'SKILL_CATALOG_FETCH_FAILED', message: 'nope' },
    } as SkillCatalogResult);
    expect((await call()).status).toBe(503);
  });

  it('still returns a plan for an incompatible Skill, marked not installable', async () => {
    getSkillCatalogMock.mockResolvedValue(catalogResult(makeCatalog('>=9.0.0')));
    const response = await call({ version: '1.2.0' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.plan.installable).toBe(false);
    expect(body.plan.skill.compatibility.commandmate.status).toBe('incompatible');
    expect(body.plan.blockers.length).toBeGreaterThan(0);
  });

  it('marks a plan not installable when an unmanaged file occupies the target', async () => {
    const installRoot = path.join(worktreeDir, '.agents/skills', SKILL_ID);
    fs.mkdirSync(installRoot, { recursive: true });
    fs.writeFileSync(path.join(installRoot, 'SKILL.md'), 'hand written\n');

    const body = await (await call()).json();
    expect(body.plan.installable).toBe(false);
    expect(body.plan.blockers[0].code).toBe('SKILL_DIFF_UNMANAGED_SKILL');
  });

  it('reports a failed artifact retrieval as 502 and releases the snapshot reference', async () => {
    downloadSkillArtifactMock.mockRejectedValue(
      new SkillFetchError(SkillFetchErrorCode.NETWORK)
    );
    const response = await call();
    expect(response.status).toBe(502);
    expect((await response.json()).code).toBe(SkillFetchErrorCode.NETWORK);
  });

  it('reports a rejected package as 422 and releases the snapshot reference', async () => {
    inspectSkillPackageMock.mockImplementation(() => {
      throw new SkillPackageError(SkillPackageErrorCode.DIGEST_MISMATCH);
    });
    const response = await call();
    expect(response.status).toBe(422);
    expect((await response.json()).code).toBe(SkillPackageErrorCode.DIGEST_MISMATCH);
    expect(releaseSkillSnapshotMock).toHaveBeenCalledWith('a'.repeat(32));
  });

  it('binds a browser plan and a CLI plan to different actors', async () => {
    const browser = await (await call()).json();
    const cli = await (await call(undefined, undefined, { authorization: 'Bearer x' })).json();
    expect(browser.plan.token).not.toBe(cli.plan.token);
  });
});
