/**
 * API Route tests — declared verification config (Issue #2061)
 * @vitest-environment node
 *
 * - GET  /api/worktrees/:id/verify/config
 * - POST /api/worktrees/:id/verify/config
 *
 * The route reads and writes real files in a real temporary repository. The
 * whole point of it is the filesystem — "does `.commandmate/verify.yaml` exist,
 * and what does it declare" — so a mocked loader would leave the only seam that
 * matters untested.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { removeTempDir } from '@tests/helpers/temp-dir';

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
const wtId = 'wt-verify-config';
const tempDirs: string[] = [];

const asReq = (req: Request) => req as unknown as NextRequest;

function createRepo(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'verify-config-api-')));
  tempDirs.push(dir);
  writeFileSync(join(dir, 'README.md'), 'base\n');
  return dir;
}

function writeConfig(body: string): void {
  mkdirSync(join(repo, '.commandmate'), { recursive: true });
  writeFileSync(join(repo, '.commandmate', 'verify.yaml'), body);
}

function writeCi(): void {
  mkdirSync(join(repo, '.github', 'workflows'), { recursive: true });
  writeFileSync(
    join(repo, '.github', 'workflows', 'ci.yml'),
    [
      'name: CI',
      'jobs:',
      '  check:',
      '    runs-on: ubuntu-latest',
      '    steps:',
      '      - name: Install',
      '        run: npm ci',
      '      - name: Lint',
      '        run: npm run lint',
      '      - name: Unit',
      '        run: npm run test:unit',
      '',
    ].join('\n')
  );
}

async function getConfig(id: string) {
  const { GET } = await import('@/app/api/worktrees/[id]/verify/config/route');
  return GET(asReq(new Request(`http://localhost/api/worktrees/${id}/verify/config`)), {
    params: Promise.resolve({ id }),
  });
}

async function postConfig(id: string) {
  const { POST } = await import('@/app/api/worktrees/[id]/verify/config/route');
  return POST(
    asReq(
      new Request(`http://localhost/api/worktrees/${id}/verify/config`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
    ),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  repo = createRepo();
  upsertWorktree(db, {
    id: wtId,
    name: 'feature/verify-config',
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
    if (dir) removeTempDir(dir);
  }
});

describe('GET /api/worktrees/:id/verify/config (Issue #2061)', () => {
  it('reports an absent config as absent, not as an error', () => {
    return getConfig(wtId)
      .then((res) => Promise.all([res.status, res.json()]))
      .then(([status, body]) => {
        expect(status).toBe(200);
        expect(body.exists).toBe(false);
        expect(body.gates).toEqual([]);
        expect(body.plannedGateIds).toEqual([]);
        expect(body.error).toBeNull();
        // The path is sent even when nothing is there: the pane names the file
        // it is telling the operator to create.
        expect(body.path).toBe('.commandmate/verify.yaml');
      });
  });

  it('returns the declared gates and the gates a default run adds', async () => {
    writeConfig(
      [
        'version: 1',
        'gates:',
        '  - id: lint',
        '    command: "npm run lint"',
        '    timeoutSec: 900',
        '  - id: e2e',
        '    command: "npm run test:e2e"',
        '    mutex: cpu.heavy',
        'options:',
        '  baseRef: origin/develop',
        '',
      ].join('\n')
    );

    const body = await (await getConfig(wtId)).json();

    expect(body.exists).toBe(true);
    expect(body.error).toBeNull();
    expect(body.gates).toEqual([
      {
        id: 'lint',
        command: 'npm run lint',
        timeoutSec: 900,
        mutex: null,
        retryOnFail: null,
        flakyIsPass: null,
      },
      {
        id: 'e2e',
        command: 'npm run test:e2e',
        timeoutSec: 600,
        mutex: 'cpu.heavy',
        retryOnFail: null,
        flakyIsPass: null,
      },
    ]);
    // work-evidence and scope always; env-clean only when declared.
    expect(body.plannedGateIds).toEqual(['work-evidence', 'scope', 'lint', 'e2e']);
    expect(body.options.baseRef).toBe('origin/develop');
  });

  it('adds env-clean to the planned gates only when the config asks for it', async () => {
    writeConfig(
      [
        'version: 1',
        'gates:',
        '  - id: lint',
        '    command: "npm run lint"',
        'options:',
        '  requireEnvClean: true',
        '',
      ].join('\n')
    );

    const body = await (await getConfig(wtId)).json();
    expect(body.plannedGateIds).toEqual(['work-evidence', 'scope', 'env-clean', 'lint']);
  });

  it('separates "the file is broken" from "there is no file"', async () => {
    writeConfig('version: 1\ngates: []\n');

    const res = await getConfig(wtId);
    const body = await res.json();

    // 200, not 500: nothing failed in the server. The repository declared
    // something unusable, and the operator has to be told which file to fix.
    expect(res.status).toBe(200);
    expect(body.exists).toBe(true);
    expect(body.gates).toEqual([]);
    expect(body.error).toContain('at least one gate must be defined');
  });

  it('404s an unknown worktree and 400s a malformed id', async () => {
    expect((await getConfig('no-such-worktree')).status).toBe(404);
    expect((await getConfig('../etc')).status).toBe(400);
  });
});

describe('POST /api/worktrees/:id/verify/config (Issue #2061)', () => {
  it('drafts gates from the repository CI and writes the file', async () => {
    writeCi();

    const res = await postConfig(wtId);
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.created).toBe(true);
    expect(body.gates.map((gate: { id: string }) => gate.id)).toEqual(['lint', 'unit']);
    expect(body.excluded).toEqual([
      expect.objectContaining({ command: 'npm ci', reason: 'setup' }),
    ]);
    expect(body.scanned).toContain('.github/workflows/ci.yml');

    // The written file is what a later GET reads back.
    const after = await (await getConfig(wtId)).json();
    expect(after.exists).toBe(true);
    expect(after.gates.map((gate: { id: string }) => gate.id)).toEqual(['lint', 'unit']);
  });

  it('never overwrites an existing config', async () => {
    writeCi();
    const existing = 'version: 1\ngates:\n  - id: mine\n    command: "true"\n';
    writeConfig(existing);

    const res = await postConfig(wtId);

    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('never overwritten');
    // The refusal is not the point; the bytes are.
    expect(readFileSync(join(repo, '.commandmate', 'verify.yaml'), 'utf8')).toBe(existing);
  });

  it('answers 422 when nothing in the repository is draftable, and writes nothing', async () => {
    const res = await postConfig(wtId);

    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('No verification gates could be drafted');
    expect(existsSync(join(repo, '.commandmate', 'verify.yaml'))).toBe(false);
  });

  it('404s an unknown worktree', async () => {
    expect((await postConfig('no-such-worktree')).status).toBe(404);
  });
});
