/**
 * API Route tests — GET /api/verification/runs and /api/verification/runs/:runId
 * (Issue #1593).
 *
 * The DB layer is NOT mocked: the contract worth defending is that a listing
 * response never contains a log body while the detail response always does, and
 * a mocked accessor would let both assertions pass against nothing.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createVerificationRun,
  createGateResult,
  finishGateResult,
  finishVerificationRun,
} from '@/lib/db/verification-db';

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
  };
});

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  }),
}));

const MS_PER_DAY = 86_400_000;
const LOG_BODY = 'FAILING ASSERTION AT line 42\nexpected 1 to be 2';

let db: Database.Database;

const asReq = (req: Request) => req as unknown as NextRequest;

function setStartedAt(runId: number, startedAt: number): void {
  db.prepare('UPDATE verification_runs SET started_at = ? WHERE id = ?').run(startedAt, runId);
}

function seedRun(opts: {
  worktreeId: string;
  daysAgo?: number;
  gateId?: string;
  status?: 'passed' | 'failed';
}): number {
  const run = createVerificationRun(db, { worktreeId: opts.worktreeId, trigger: 'manual' });
  const gate = createGateResult(db, run.id, {
    gateId: opts.gateId ?? 'unit',
    command: 'npm run test:unit',
    source: 'verify.yaml',
  });
  finishGateResult(db, gate.id, {
    status: opts.status ?? 'failed',
    exitCode: opts.status === 'passed' ? 0 : 1,
    durationMs: 45_000,
    logTail: LOG_BODY,
  });
  finishVerificationRun(db, run.id, opts.status ?? 'failed');
  if (opts.daysAgo !== undefined) setStartedAt(run.id, Date.now() - opts.daysAgo * MS_PER_DAY);
  return run.id;
}

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  db.close();
});

async function list(url: string) {
  const { GET } = await import('@/app/api/verification/runs/route');
  return GET(asReq(new Request(url)));
}

async function detail(runId: string) {
  const { GET } = await import('@/app/api/verification/runs/[runId]/route');
  return GET(asReq(new Request(`http://localhost/api/verification/runs/${runId}`)), {
    params: Promise.resolve({ runId }),
  });
}

describe('GET /api/verification/runs — the listing never carries log bodies', () => {
  it('returns gate summaries without logTail', async () => {
    seedRun({ worktreeId: 'wt-1' });

    const res = await list('http://localhost/api/verification/runs');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.runs).toHaveLength(1);
    expect(body.runs[0].gates[0]).toEqual({
      gateId: 'unit',
      status: 'failed',
      exitCode: 1,
      durationMs: 45_000,
      // Where the gate was declared (#1791) — the listing carries it, the log
      // body it never has.
      source: 'verify.yaml',
    });
    expect(body.runs[0].gates[0]).not.toHaveProperty('logTail');
  });

  it('never leaks the log text anywhere in the serialized response', async () => {
    seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-2' });

    const res = await list('http://localhost/api/verification/runs');

    expect(JSON.stringify(await res.json())).not.toContain('FAILING ASSERTION');
  });
});

describe('GET /api/verification/runs — filters', () => {
  it('spans every worktree by default', async () => {
    seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-2' });

    const body = await (await list('http://localhost/api/verification/runs')).json();

    expect(body.runs.map((r: { worktreeId: string }) => r.worktreeId).sort()).toEqual([
      'wt-1',
      'wt-2',
    ]);
  });

  it('narrows to one worktree with ?worktreeId=', async () => {
    const mine = seedRun({ worktreeId: 'wt-1' });
    seedRun({ worktreeId: 'wt-2' });

    const body = await (
      await list('http://localhost/api/verification/runs?worktreeId=wt-1')
    ).json();

    expect(body.runs.map((r: { id: number }) => r.id)).toEqual([mine]);
  });

  it('returns an empty list, not 404, for a worktree id that matches nothing', async () => {
    seedRun({ worktreeId: 'wt-1' });

    const res = await list('http://localhost/api/verification/runs?worktreeId=nosuchworktree');

    expect(res.status).toBe(200);
    expect((await res.json()).runs).toEqual([]);
  });

  it('narrows the window with ?days=', async () => {
    const recent = seedRun({ worktreeId: 'wt-1', daysAgo: 2 });
    seedRun({ worktreeId: 'wt-1', daysAgo: 30 });

    const week = await (await list('http://localhost/api/verification/runs?days=7')).json();
    expect(week.runs.map((r: { id: number }) => r.id)).toEqual([recent]);

    const all = await (await list('http://localhost/api/verification/runs')).json();
    expect(all.runs).toHaveLength(2);
  });

  it('caps the page with ?limit=', async () => {
    for (let i = 0; i < 5; i += 1) seedRun({ worktreeId: 'wt-1' });

    const body = await (await list('http://localhost/api/verification/runs?limit=2')).json();

    expect(body.runs).toHaveLength(2);
  });

  it('combines worktreeId, days and limit', async () => {
    const wanted = seedRun({ worktreeId: 'wt-1', daysAgo: 1 });
    seedRun({ worktreeId: 'wt-1', daysAgo: 40 });
    seedRun({ worktreeId: 'wt-2', daysAgo: 1 });

    const body = await (
      await list('http://localhost/api/verification/runs?worktreeId=wt-1&days=7&limit=10')
    ).json();

    expect(body.runs.map((r: { id: number }) => r.id)).toEqual([wanted]);
  });
});

describe('GET /api/verification/runs — validation', () => {
  it('accepts the range boundaries', async () => {
    expect((await list('http://localhost/api/verification/runs?days=1')).status).toBe(200);
    expect((await list('http://localhost/api/verification/runs?days=90')).status).toBe(200);
    expect((await list('http://localhost/api/verification/runs?limit=1')).status).toBe(200);
    expect((await list('http://localhost/api/verification/runs?limit=500')).status).toBe(200);
  });

  it.each(['0', '91', '-1', '7.5', 'abc', ''])('rejects days=%s with 400', async (value) => {
    const res = await list(`http://localhost/api/verification/runs?days=${value}`);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('days must be an integer');
  });

  it.each(['0', '501', '-1', '2.5', 'abc', ''])('rejects limit=%s with 400', async (value) => {
    const res = await list(`http://localhost/api/verification/runs?limit=${value}`);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('limit must be an integer');
  });

  it.each(['../etc', 'wt 1', ''])('rejects worktreeId=%s with 400', async (value) => {
    const res = await list(
      `http://localhost/api/verification/runs?worktreeId=${encodeURIComponent(value)}`
    );

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid worktree ID format');
  });

  it('returns 500 when the database is unreachable', async () => {
    db.close();

    const res = await list('http://localhost/api/verification/runs');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to list verification runs');
  });
});

describe('GET /api/verification/runs/:runId — the detail carries log bodies', () => {
  it('returns every gate result with its logTail', async () => {
    const runId = seedRun({ worktreeId: 'wt-1' });

    const res = await detail(String(runId));
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.run.id).toBe(runId);
    expect(body.run.worktreeId).toBe('wt-1');
    expect(body.run.status).toBe('failed');
    expect(body.run.gates).toHaveLength(1);
    expect(body.run.gates[0].logTail).toBe(LOG_BODY);
    expect(body.run.gates[0].command).toBe('npm run test:unit');
  });

  it('resolves a run without being told which worktree owns it', async () => {
    seedRun({ worktreeId: 'wt-1' });
    const other = seedRun({ worktreeId: 'wt-2' });

    const body = await (await detail(String(other))).json();

    expect(body.run.worktreeId).toBe('wt-2');
  });

  it('returns 404 for a run id that does not exist', async () => {
    seedRun({ worktreeId: 'wt-1' });

    const res = await detail('9999');

    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('Verification run not found');
  });

  it.each(['0', '-1', 'abc', '1.5', '01'])('rejects runId=%s with 400', async (value) => {
    const res = await detail(value);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('Invalid run ID format');
  });

  it('returns 500 when the database is unreachable', async () => {
    const runId = seedRun({ worktreeId: 'wt-1' });
    db.close();

    const res = await detail(String(runId));

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to fetch verification run');
  });
});
