/**
 * API integration tests — installed-Skill list route (Issue #1440)
 *
 * The route projects the installed-Skill index (#1235) for one worktree. What is
 * under test: it resolves the worktree from the database (never from the request),
 * returns only receipt/index facts — never a machine-absolute path or artifact
 * URL — and scopes the list to the requested worktree alone.
 *
 * Nothing here touches the network or the production database: a fresh in-memory
 * SQLite database backs `listSkillInstallations`, and worktree resolution is
 * mocked, so the test exercises the real index read through the route.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertSkillInstallation } from '@/lib/skills/installed-state';
import type { SkillInstallReceipt } from '@/types/skills';
import type { Worktree } from '@/types/models';

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

import { GET } from '@/app/api/worktrees/[id]/skills/route';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';

const getDbInstanceMock = vi.mocked(getDbInstance);
const getWorktreeByIdMock = vi.mocked(getWorktreeById);

const T0 = 1_800_000_000_000;
const WORKTREE_ID = 'demo-wt';
const WORKTREE_PATH = `/tmp/cm-1440/repo/${WORKTREE_ID}`;

let db: Database.Database;

function makeReceipt(overrides: Partial<SkillInstallReceipt> = {}): SkillInstallReceipt {
  return {
    schema_version: 1,
    skill_id: 'demo-skill',
    version: '1.2.3',
    install_root: '.agents/skills/demo-skill',
    source: {
      repository: 'Kewton/commandmate-skills',
      ref: 'demo-skill-v1.2.3',
      commit: 'b'.repeat(40),
    },
    artifact: {
      asset_name: 'demo-skill-1.2.3.tar.gz',
      sha256: 'c'.repeat(64),
      size: 2048,
      format: 'tar.gz',
    },
    files: [],
    declared_risk: 'low',
    computed_risk: 'low',
    effective_risk: 'low',
    declared_permissions: [],
    agent_compatibility: [],
    ...overrides,
  };
}

/** Since #1430 an index row is tied to a live worktree, so the parent must exist. */
function insertWorktree(id: string): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name)
     VALUES (?, ?, ?, '/tmp/cm-1440/repo', 'repo')`
  ).run(id, id, `/tmp/cm-1440/repo/${id}`);
}

function install(worktreeId: string, receipt: SkillInstallReceipt, operationId: string): void {
  upsertSkillInstallation(db, {
    worktreeId,
    receipt,
    receiptSha256: 'd'.repeat(64),
    operationId,
    installedAt: T0,
  });
}

function makeWorktree(): Worktree {
  return {
    id: WORKTREE_ID,
    name: 'feature/demo',
    path: WORKTREE_PATH,
    repositoryPath: '/tmp/cm-1440/repo',
    repositoryName: 'repo',
    branch: 'feature/demo',
  };
}

function call(id: string = WORKTREE_ID) {
  const request = new NextRequest(`http://localhost:3000/api/worktrees/${id}/skills`);
  return GET(request, { params: Promise.resolve({ id }) });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  insertWorktree(WORKTREE_ID);
  insertWorktree('other-wt');
  vi.clearAllMocks();
  getDbInstanceMock.mockReturnValue(db);
  getWorktreeByIdMock.mockReturnValue(makeWorktree());
});

afterEach(() => {
  db.close();
});

describe('GET /api/worktrees/[id]/skills', () => {
  it('lists the Skills installed in the resolved worktree', async () => {
    install(WORKTREE_ID, makeReceipt(), 'op-1');

    const response = await call();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.worktreeId).toBe(WORKTREE_ID);
    expect(body.skills).toHaveLength(1);
    expect(body.skills[0]).toEqual({
      skillId: 'demo-skill',
      version: '1.2.3',
      installRoot: '.agents/skills/demo-skill',
      receiptSha256: 'd'.repeat(64),
      artifactSha256: 'c'.repeat(64),
      source: {
        repository: 'Kewton/commandmate-skills',
        ref: 'demo-skill-v1.2.3',
        commit: 'b'.repeat(40),
      },
      effectiveRisk: 'low',
      installedAt: T0,
      updatedAt: T0,
    });
    expect(response.headers.get('Cache-Control')).toContain('no-store');
  });

  it('resolves the worktree from the database, never from the request', async () => {
    await call();
    expect(getWorktreeByIdMock).toHaveBeenCalledWith(expect.anything(), WORKTREE_ID);
  });

  it('returns an empty list — not an error — when nothing is installed', async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect((await response.json()).skills).toEqual([]);
  });

  it('scopes the list to the requested worktree', async () => {
    install(WORKTREE_ID, makeReceipt({ skill_id: 'skill-a' }), 'op-a');
    install(WORKTREE_ID, makeReceipt({ skill_id: 'skill-b' }), 'op-b');
    install('other-wt', makeReceipt({ skill_id: 'skill-c' }), 'op-c');

    const body = await (await call()).json();
    expect(body.skills.map((s: { skillId: string }) => s.skillId)).toEqual(['skill-a', 'skill-b']);
  });

  it('leaks no absolute path or artifact URL into the response', async () => {
    install(
      WORKTREE_ID,
      makeReceipt({
        artifact: {
          asset_name: 'demo-skill-1.2.3.tar.gz',
          sha256: 'c'.repeat(64),
          size: 2048,
          format: 'tar.gz',
        },
      }),
      'op-1'
    );

    const text = await (await call()).text();
    expect(text).not.toContain(WORKTREE_PATH);
    expect(text).not.toContain('http://');
    expect(text).not.toContain('https://');
  });

  it('rejects an invalid worktree ID with 400 before any DB read', async () => {
    const response = await call('../etc');
    expect(response.status).toBe(400);
    expect(getWorktreeByIdMock).not.toHaveBeenCalled();
  });

  it('returns 404 for an unregistered worktree', async () => {
    getWorktreeByIdMock.mockReturnValue(undefined as unknown as Worktree);
    expect((await call()).status).toBe(404);
  });
});
