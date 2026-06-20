/**
 * API Routes Integration Tests - Global Todos (cross-repository, Issue #907)
 *
 * Tests for:
 * - GET /api/todos - List todos across all repositories
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import { createTodo } from '@/lib/db';

declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

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

let db: Database.Database;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);

  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

describe('GET /api/todos', () => {
  it('returns an empty array when no todos exist', async () => {
    const { GET } = await import('@/app/api/todos/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos).toEqual([]);
  });

  it('returns todos across all repositories with resolved repository names', async () => {
    const alpha = createRepository(db, {
      name: 'Alpha',
      path: '/path/to/alpha',
      cloneSource: 'local',
    });
    const beta = createRepository(db, {
      name: 'Beta',
      path: '/path/to/beta',
      cloneSource: 'local',
    });
    createTodo(db, beta.id, { content: 'beta task', position: 0 });
    createTodo(db, alpha.id, { content: 'alpha task', position: 0 });

    const { GET } = await import('@/app/api/todos/route');
    const res = await GET();
    expect(res.status).toBe(200);
    const data = await res.json();

    // Ordered by repository label (Alpha before Beta).
    expect(data.todos.map((t: { content: string }) => t.content)).toEqual([
      'alpha task',
      'beta task',
    ]);
    expect(data.todos[0].repositoryName).toBe('Alpha');
    expect(data.todos[1].repositoryName).toBe('Beta');
  });

  it('returns 500 on database error', async () => {
    db.close();
    const { GET } = await import('@/app/api/todos/route');
    const res = await GET();
    expect(res.status).toBe(500);
  });
});
