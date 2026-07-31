/**
 * API Route tests — GET /api/metrics/vibe (Issue #1551, Phase 4).
 *
 * The aggregator is NOT mocked: the point of the route is that real rows in a
 * real database come back as numbers, and a mocked aggregator would leave the
 * only seam that can break — the `days` window reaching the query — untested.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import type { NextRequest } from 'next/server';
import { runMigrations } from '@/lib/db/db-migrations';
import { MS_PER_DAY } from '@/lib/metrics/vibe-metrics';

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

let db: Database.Database;
let taskSeq = 0;

const asReq = (req: Request) => req as unknown as NextRequest;

function seedTask(status: string, createdAt: number): void {
  const id = `task-${++taskSeq}`;
  db.prepare(`
    INSERT INTO tasks (id, worktree_id, cli_tool_id, instance_id, title, goal,
                       contract_path, contract_json, status,
                       last_verification_run_id, created_at, updated_at)
    VALUES (?, 'wt-1', 'claude', NULL, 'a task', 'do it', NULL, '{}', ?, NULL, ?, ?)
  `).run(id, status, createdAt, createdAt);
}

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);
  taskSeq = 0;
  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(() => {
  db.close();
});

async function get(url: string) {
  const { GET } = await import('@/app/api/metrics/vibe/route');
  return GET(asReq(new Request(url)));
}

describe('GET /api/metrics/vibe', () => {
  it('returns aggregated metrics for the default 7-day window', async () => {
    seedTask('succeeded', Date.now() - MS_PER_DAY);
    seedTask('failed', Date.now() - MS_PER_DAY);

    const res = await get('http://localhost/api/metrics/vibe');
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.metrics.periodDays).toBe(7);
    expect(body.metrics.tasks.total).toBe(2);
    expect(body.metrics.tasks.succeeded).toBe(1);
    expect(body.metrics.tasks.successRate).toBe(0.5);
    expect(body.metrics.intervention.suppressedByPolicy).toBeNull();
  });

  it('honours ?days= by narrowing the window', async () => {
    seedTask('succeeded', Date.now() - 5 * MS_PER_DAY);
    seedTask('succeeded', Date.now() - 1 * MS_PER_DAY);

    const week = await (await get('http://localhost/api/metrics/vibe?days=7')).json();
    expect(week.metrics.tasks.total).toBe(2);

    const yesterday = await (await get('http://localhost/api/metrics/vibe?days=2')).json();
    expect(yesterday.metrics.periodDays).toBe(2);
    expect(yesterday.metrics.tasks.total).toBe(1);
  });

  it('accepts the range boundaries', async () => {
    expect((await get('http://localhost/api/metrics/vibe?days=1')).status).toBe(200);
    expect((await get('http://localhost/api/metrics/vibe?days=90')).status).toBe(200);
  });

  it.each(['0', '91', '-1', '7.5', 'abc', ''])('rejects days=%s with 400', async (value) => {
    const res = await get(`http://localhost/api/metrics/vibe?days=${value}`);

    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('days must be an integer');
  });

  it('degrades to zeros when the tables do not exist', async () => {
    db.exec('DROP TABLE tasks');
    db.exec('DROP TABLE task_events');
    db.exec('DROP TABLE verification_gate_results');
    db.exec('DROP TABLE verification_runs');

    const res = await get('http://localhost/api/metrics/vibe');

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.metrics.tasks.total).toBe(0);
    expect(body.metrics.tasks.successRate).toBeNull();
    expect(body.metrics.verification.gateFailBreakdown).toEqual([]);
  });

  it('returns 500 when the database is unreachable', async () => {
    db.close();

    const res = await get('http://localhost/api/metrics/vibe');

    expect(res.status).toBe(500);
    expect((await res.json()).error).toBe('Failed to compute vibe metrics');
  });
});
