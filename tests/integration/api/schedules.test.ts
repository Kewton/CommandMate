/**
 * API Routes Integration Tests - Schedules (POST)
 *
 * Issue #1351: scheduled_executions has a UNIQUE(worktree_id, name) constraint.
 * Creating a same-named schedule previously fell through to a raw INSERT whose
 * UNIQUE violation surfaced as an opaque 500. The route must instead validate
 * up-front and return an explicit 409.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import type { Worktree } from '@/types/models';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock only the DB instance provider; the route uses the real getWorktreeById.
vi.mock('@/lib/db/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
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

vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

const VALID_BODY = {
  name: 'daily-report',
  message: 'Generate the daily report',
  cronExpression: '0 0 * * *',
};

function makeRequest(worktreeId: string, body: unknown): Request {
  return new Request(`http://localhost:3000/api/worktrees/${worktreeId}/schedules`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api/worktrees/:id/schedules', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);

    const worktree: Worktree = {
      id: 'test-worktree',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };
    upsertWorktree(db, worktree);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('creates a schedule on the happy path (201)', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/schedules/route');

    const response = await POST(
      makeRequest('test-worktree', VALID_BODY) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'test-worktree' }) }
    );

    expect(response.status).toBe(201);
    const data = await response.json();
    expect(data.schedule.name).toBe('daily-report');
  });

  it('returns 409 (not 500) when a schedule with the same name already exists (Issue #1351)', async () => {
    const { POST } = await import('@/app/api/worktrees/[id]/schedules/route');

    // First creation succeeds.
    const first = await POST(
      makeRequest('test-worktree', VALID_BODY) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'test-worktree' }) }
    );
    expect(first.status).toBe(201);

    // Second creation with the same (worktree_id, name) must be rejected explicitly.
    const second = await POST(
      makeRequest('test-worktree', { ...VALID_BODY, message: 'different message' }) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'test-worktree' }) }
    );

    expect(second.status).toBe(409);
    const data = await second.json();
    expect(data.code).toBe('DUPLICATE_NAME');
    expect(data.error).toContain('already exists');

    // Only the first schedule should exist.
    const rows = db
      .prepare('SELECT COUNT(*) AS n FROM scheduled_executions WHERE worktree_id = ? AND name = ?')
      .get('test-worktree', VALID_BODY.name) as { n: number };
    expect(rows.n).toBe(1);
  });

  it('allows the same name under a different worktree (constraint is scoped to worktree)', async () => {
    upsertWorktree(db, {
      id: 'other-worktree',
      name: 'other',
      path: '/path/to/other',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    });

    const { POST } = await import('@/app/api/worktrees/[id]/schedules/route');

    const a = await POST(
      makeRequest('test-worktree', VALID_BODY) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'test-worktree' }) }
    );
    expect(a.status).toBe(201);

    const b = await POST(
      makeRequest('other-worktree', VALID_BODY) as unknown as import('next/server').NextRequest,
      { params: Promise.resolve({ id: 'other-worktree' }) }
    );
    expect(b.status).toBe(201);
  });
});
