/**
 * API Route tests — verification runs (Issue #1543)
 *
 * - POST /api/worktrees/:id/verify
 * - GET  /api/worktrees/:id/verify/runs
 * - GET  /api/worktrees/:id/verify/runs/:runId
 *
 * The gate runner is NOT mocked: the point of these routes is that a POST
 * produces a record a later GET can read, and a mocked runner would leave that
 * seam untested. Fixture gates are `sh -c 'exit N'`, so they cost milliseconds.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { vi } from 'vitest';
import Database from 'better-sqlite3';
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { waitForVerification } from '@/lib/verification/gate-runner';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;
  return {
    getDbInstance: () => {
      if (!mockDb) throw new Error('Mock database not initialized');
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

let db: Database.Database;
let repo: string;
const wtId = 'wt-verify';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

function git(args: string[], cwd: string): void {
  execFileSync('git', args, { cwd, stdio: 'ignore' });
}

function createRepo(verifyYaml: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-api-')));
  tempDirs.push(dir);
  git(['init', '-b', 'main'], dir);
  git(['config', 'user.email', 'verify@example.test'], dir);
  git(['config', 'user.name', 'Verify'], dir);
  git(['config', 'commit.gpgsign', 'false'], dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  mkdirSync(join(dir, '.commandmate'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), verifyYaml);
  git(['add', '-A'], dir);
  git(['commit', '-m', 'base'], dir);
  git(['checkout', '-b', 'work'], dir);
  // Uncommitted work, so the built-in work-evidence gate has something to find.
  writeFileSync(join(dir, 'work.txt'), 'agent output\n');
  return dir;
}

async function postVerify(id: string, body?: unknown) {
  const { POST } = await import('@/app/api/worktrees/[id]/verify/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/verify`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ),
    { params: Promise.resolve({ id }) }
  );
}

async function getRuns(id: string, query = '') {
  const { GET } = await import('@/app/api/worktrees/[id]/verify/runs/route');
  return GET(asReq(new Request(`http://localhost/api/worktrees/${id}/verify/runs${query}`)), {
    params: Promise.resolve({ id }),
  });
}

async function getRun(id: string, runId: string) {
  const { GET } = await import('@/app/api/worktrees/[id]/verify/runs/[runId]/route');
  return GET(
    asReq(new Request(`http://localhost/api/worktrees/${id}/verify/runs/${runId}`)),
    { params: Promise.resolve({ id, runId }) }
  );
}

const PASSING_CONFIG = `
version: 1
gates:
  - id: quick
    command: "sh -c 'exit 0'"
    timeoutSec: 30
options:
  baseRef: main
`;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo(PASSING_CONFIG);
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/verify',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe('POST /api/worktrees/:id/verify', () => {
  it('accepts the run with 202 and the verdict is readable afterwards', async () => {
    const res = await postVerify(wtId);
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    expect(typeof runId).toBe('number');

    await waitForVerification(runId);

    const detail = await getRun(wtId, String(runId));
    expect(detail.status).toBe(200);
    const { run } = await detail.json();
    expect(run.status).toBe('passed');
    expect(run.trigger).toBe('api');
    expect(run.gates.map((g: { gateId: string }) => g.gateId)).toEqual([
      'work-evidence',
      'scope',
      'quick',
    ]);
    expect(run.gates[2].exitCode).toBe(0);
  });

  it('reports a failing gate through the API rather than an error status', async () => {
    rmSync(join(repo, '.commandmate', 'verify.yaml'));
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `
version: 1
gates:
  - id: broken
    command: "sh -c 'exit 7'"
    timeoutSec: 30
options:
  baseRef: main
`
    );

    const res = await postVerify(wtId, { trigger: 'manual' });
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await waitForVerification(runId);

    const { run } = await (await getRun(wtId, String(runId))).json();
    expect(run.status).toBe('failed');
    expect(run.trigger).toBe('manual');
    expect(run.gates.find((g: { gateId: string }) => g.gateId === 'broken').exitCode).toBe(7);
  });

  it('defaults the trigger to api when the body is absent', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/verify/route');
    const res = await POST(
      asReq(new Request(`http://localhost/api/worktrees/${wtId}/verify`, { method: 'POST' })),
      { params: Promise.resolve({ id: wtId }) }
    );
    expect(res.status).toBe(202);
    const { runId } = await res.json();
    await waitForVerification(runId);

    const { run } = await (await getRun(wtId, String(runId))).json();
    expect(run.trigger).toBe('api');
  });

  it('returns 409 while a run is already in flight', async () => {
    rmSync(join(repo, '.commandmate', 'verify.yaml'));
    writeFileSync(
      join(repo, '.commandmate', 'verify.yaml'),
      `
version: 1
gates:
  - id: slow
    command: "sleep 1"
    timeoutSec: 30
options:
  baseRef: main
`
    );

    const first = await postVerify(wtId);
    expect(first.status).toBe(202);
    const { runId } = await first.json();

    const second = await postVerify(wtId);
    expect(second.status).toBe(409);
    expect((await second.json()).runningRunId).toBe(runId);

    await waitForVerification(runId);

    // The lock is held by the run, not by the worktree forever.
    expect((await postVerify(wtId)).status).toBe(202);
  });

  it('returns 404 for an unknown worktree', async () => {
    const res = await postVerify('no-such-worktree');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed worktree id', async () => {
    const res = await postVerify('../etc');
    expect(res.status).toBe(400);
  });

  it.each([
    ['an unknown trigger', { trigger: 'cron' }],
    ['a non-array gateIds', { gateIds: 'quick' }],
    ['an empty gateIds', { gateIds: [] }],
    ['a blank gate id', { gateIds: ['  '] }],
    ['a non-string gate id', { gateIds: [1] }],
    ['an invalid instanceId', { instanceId: 'not a valid id!' }],
  ])('returns 400 for %s', async (_label, body) => {
    const res = await postVerify(wtId, body);
    expect(res.status).toBe(400);
    // Rejected before the runner was reached, so no record was opened.
    expect((await (await getRuns(wtId)).json()).runs).toEqual([]);
  });
});

describe('GET /api/worktrees/:id/verify/runs', () => {
  it('lists runs newest first without gate results', async () => {
    for (let i = 0; i < 2; i += 1) {
      const { runId } = await (await postVerify(wtId)).json();
      await waitForVerification(runId);
    }

    const res = await getRuns(wtId);
    expect(res.status).toBe(200);
    const { runs } = await res.json();
    expect(runs).toHaveLength(2);
    expect(runs[0].id).toBeGreaterThan(runs[1].id);
    expect(runs[0].gates).toBeUndefined();
  });

  it('honours the limit query parameter', async () => {
    for (let i = 0; i < 2; i += 1) {
      const { runId } = await (await postVerify(wtId)).json();
      await waitForVerification(runId);
    }

    const { runs } = await (await getRuns(wtId, '?limit=1')).json();
    expect(runs).toHaveLength(1);
  });

  it.each(['?limit=0', '?limit=101', '?limit=abc', '?limit=1.5'])(
    'returns 400 for %s',
    async (query) => {
      expect((await getRuns(wtId, query)).status).toBe(400);
    }
  );

  it('returns 404 for an unknown worktree', async () => {
    expect((await getRuns('no-such-worktree')).status).toBe(404);
  });
});

describe('GET /api/worktrees/:id/verify/runs/:runId', () => {
  it('returns 404 for a run id that does not exist', async () => {
    expect((await getRun(wtId, '999')).status).toBe(404);
  });

  it.each(['0', '-1', 'abc', '1e3'])('returns 400 for run id %s', async (runId) => {
    expect((await getRun(wtId, runId)).status).toBe(400);
  });

  it('does not serve a run belonging to another worktree', async () => {
    const other = createRepo(PASSING_CONFIG);
    upsertWorktree(db, {
      id: 'wt-other',
      name: 'feature/other',
      path: other,
      repositoryPath: other,
      repositoryName: 'fixture',
    });

    const { runId } = await (await postVerify('wt-other')).json();
    await waitForVerification(runId);

    // The run exists and is readable under its own worktree...
    expect((await getRun('wt-other', String(runId))).status).toBe(200);
    // ...but run ids are global, so it must not surface under another's URL.
    expect((await getRun(wtId, String(runId))).status).toBe(404);
  });
});
