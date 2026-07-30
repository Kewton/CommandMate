/**
 * API Route tests — execution contracts (Issue #1545, Phase 2-1)
 *
 * - POST /api/worktrees/:id/tasks
 * - GET  /api/worktrees/:id/tasks
 * - GET  /api/tasks/:taskId
 * - PATCH /api/tasks/:taskId
 *
 * The contract loader is NOT mocked: the point of POST is that a real file in a
 * real worktree becomes a task row whose contract a later GET can read, and a
 * mocked loader would leave that seam untested.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { getTask, upsertWorktree } from '@/lib/db';
// See tasks-db.test.ts: fixtures reach past the barrel on purpose (#1548).
import { updateTaskStatus } from '@/lib/db/tasks-db';

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
const wtId = 'wt-tasks';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

const VERIFY_CONFIG = `version: 1
gates:
  - id: lint
    command: "npm run lint"
  - id: unit
    command: "npm run test:unit"
options:
  baseRef: main
`;

const CONTRACT = `version: 1
title: "loader work"
goal: |
  Implement the loader.
scope:
  allow: ["src/lib/tasks/**"]
verify:
  gates: [lint]
`;

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'tasks-api-')));
  tempDirs.push(dir);
  mkdirSync(join(dir, '.commandmate', 'tasks'), { recursive: true });
  writeFileSync(join(dir, '.commandmate', 'verify.yaml'), VERIFY_CONFIG);
  return dir;
}

function writeContract(yaml: string, name = 'task.yaml'): string {
  writeFileSync(join(repo, '.commandmate', 'tasks', name), yaml);
  return `.commandmate/tasks/${name}`;
}

async function postTask(id: string, body?: unknown) {
  const { POST } = await import('@/app/api/worktrees/[id]/tasks/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/tasks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
    ),
    { params: Promise.resolve({ id }) }
  );
}

async function listTasksRoute(id: string, query = '') {
  const { GET } = await import('@/app/api/worktrees/[id]/tasks/route');
  return GET(asReq(new Request(`http://localhost/api/worktrees/${id}/tasks${query}`)), {
    params: Promise.resolve({ id }),
  });
}

async function getTaskRoute(taskId: string) {
  const { GET } = await import('@/app/api/tasks/[taskId]/route');
  return GET(asReq(new Request(`http://localhost/api/tasks/${taskId}`)), {
    params: Promise.resolve({ taskId }),
  });
}

async function patchTaskRoute(taskId: string, body: unknown) {
  const { PATCH } = await import('@/app/api/tasks/[taskId]/route');
  return PATCH(
    asReq(
      new Request(`http://localhost/api/tasks/${taskId}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
    ),
    { params: Promise.resolve({ taskId }) }
  );
}

/** Create a task through the route and return its id. */
async function seedTask(contract = CONTRACT): Promise<string> {
  const response = await postTask(wtId, { contractPath: writeContract(contract) });
  expect(response.status).toBe(201);
  const body = await response.json();
  return body.task.id as string;
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/tasks',
    path: repo,
    repositoryPath: repo,
    repositoryName: 'fixture',
    cliToolId: 'codex',
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

describe('POST /api/worktrees/:id/tasks', () => {
  it('records a pending task and returns the composed message', async () => {
    const response = await postTask(wtId, { contractPath: writeContract(CONTRACT) });
    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body.task.status).toBe('pending');
    expect(body.task.title).toBe('loader work');
    expect(body.task.contractPath).toBe('.commandmate/tasks/task.yaml');
    expect(body.task.contract.verify.gates).toEqual(['lint']);
    // The gate id is expanded into the command the gate will actually run.
    expect(body.message).toContain('npm run lint');
    expect(body.message).toContain('src/lib/tasks/**');
    expect(body.message).toContain('Implement the loader.');

    expect(getTask(db, body.task.id)?.status).toBe('pending');
  });

  it('defaults cli_tool_id to the worktree agent and honours an explicit one', async () => {
    const path = writeContract(CONTRACT);
    const defaulted = await (await postTask(wtId, { contractPath: path })).json();
    expect(defaulted.task.cliToolId).toBe('codex');

    const explicit = await (
      await postTask(wtId, { contractPath: path, cliToolId: 'claude', instanceId: 'claude-2' })
    ).json();
    expect(explicit.task.cliToolId).toBe('claude');
    expect(explicit.task.instanceId).toBe('claude-2');
  });

  it('reports every contract violation at once and records no task', async () => {
    const path = writeContract(
      `version: 3
title: ""
goal: g
scope:
  allow: ["/etc/**"]
`,
      'broken.yaml'
    );

    const response = await postTask(wtId, { contractPath: path });
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toBe('Invalid task contract');
    expect(body.issues).toContain('version: must be 1 (got 3)');
    expect(body.issues).toContain('title: required, must be a non-empty string (got "")');
    expect(body.issues.length).toBeGreaterThanOrEqual(3);

    expect(db.prepare('SELECT COUNT(*) AS n FROM tasks').get()).toEqual({ n: 0 });
  });

  it('rejects a gate id that verify.yaml does not declare', async () => {
    const path = writeContract(
      `version: 1
title: t
goal: g
scope:
  allow: ["src/**"]
verify:
  gates: [e2e]
`,
      'unknown-gate.yaml'
    );

    const response = await postTask(wtId, { contractPath: path });
    expect(response.status).toBe(400);
    expect((await response.json()).issues[0]).toContain('unknown gate id(s) e2e');
  });

  it('rejects a contract path that escapes the worktree', async () => {
    const response = await postTask(wtId, { contractPath: '../outside.yaml' });
    expect(response.status).toBe(400);
    expect((await response.json()).issues[0]).toContain('must be inside the worktree');
  });

  it('rejects a missing contractPath', async () => {
    expect((await postTask(wtId, {})).status).toBe(400);
    expect((await postTask(wtId, { contractPath: '   ' })).status).toBe(400);
  });

  it('rejects an unknown agent id', async () => {
    const response = await postTask(wtId, {
      contractPath: writeContract(CONTRACT),
      cliToolId: 'not-an-agent',
    });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid cliToolId');
  });

  it('404s an unknown worktree and 400s a malformed id', async () => {
    expect((await postTask('absent', { contractPath: '.commandmate/tasks/task.yaml' })).status).toBe(
      404
    );
    expect((await postTask('bad id!', { contractPath: 'x.yaml' })).status).toBe(400);
  });
});

describe('GET /api/worktrees/:id/tasks', () => {
  it('lists recorded tasks', async () => {
    const first = await seedTask();
    const second = await seedTask();

    const body = await (await listTasksRoute(wtId)).json();
    expect(body.tasks.map((t: { id: string }) => t.id)).toEqual([second, first]);
  });

  it('rejects a limit that is not a positive integer in range', async () => {
    expect((await listTasksRoute(wtId, '?limit=0')).status).toBe(400);
    expect((await listTasksRoute(wtId, '?limit=abc')).status).toBe(400);
    expect((await listTasksRoute(wtId, '?limit=101')).status).toBe(400);
    expect((await listTasksRoute(wtId, '?limit=5')).status).toBe(200);
  });
});

describe('GET /api/tasks/:taskId', () => {
  it('returns the task with no run before any verification has happened', async () => {
    const taskId = await seedTask();
    const body = await (await getTaskRoute(taskId)).json();

    expect(body.task.id).toBe(taskId);
    expect(body.lastVerificationRun).toBeNull();
  });

  it('404s an unknown task and 400s a non-UUID id', async () => {
    expect((await getTaskRoute('00000000-0000-4000-8000-000000000000')).status).toBe(404);
    expect((await getTaskRoute('not-a-uuid')).status).toBe(400);
  });
});

describe('PATCH /api/tasks/:taskId', () => {
  it('accepts running and stamps started_at', async () => {
    const taskId = await seedTask();
    const response = await patchTaskRoute(taskId, { status: 'running' });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.task.status).toBe('running');
    expect(body.task.startedAt).not.toBeNull();
  });

  it('accepts failed, so an undeliverable message lands as a failure', async () => {
    const taskId = await seedTask();
    const body = await (await patchTaskRoute(taskId, { status: 'failed' })).json();

    expect(body.task.status).toBe('failed');
    expect(body.task.finishedAt).not.toBeNull();
  });

  it('refuses to let a client claim success', async () => {
    const taskId = await seedTask();
    const response = await patchTaskRoute(taskId, { status: 'succeeded' });

    expect(response.status).toBe(400);
    expect(getTask(db, taskId)?.status).toBe('pending');
  });

  it('refuses server-owned statuses', async () => {
    const taskId = await seedTask();
    for (const status of ['verifying', 'not_started', 'pending', 'waiting_input']) {
      expect((await patchTaskRoute(taskId, { status })).status).toBe(400);
    }
    expect(getTask(db, taskId)?.status).toBe('pending');
  });

  it('refuses to reopen a terminal task', async () => {
    const taskId = await seedTask();
    updateTaskStatus(db, taskId, 'succeeded');

    const response = await patchTaskRoute(taskId, { status: 'running' });
    expect(response.status).toBe(409);
    expect(getTask(db, taskId)?.status).toBe('succeeded');
  });

  it('404s an unknown task', async () => {
    expect(
      (await patchTaskRoute('00000000-0000-4000-8000-000000000000', { status: 'running' })).status
    ).toBe(404);
  });
});
