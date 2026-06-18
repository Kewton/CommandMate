/**
 * API Routes Integration Tests - Repository ToDos
 *
 * Tests for:
 * - GET    /api/repositories/:id/todos          - List todos for a repository
 * - POST   /api/repositories/:id/todos          - Create a todo
 * - PATCH  /api/repositories/:id/todos/:todoId  - Update a todo (content/done)
 * - DELETE /api/repositories/:id/todos/:todoId  - Delete a todo
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository } from '@/lib/db/db-repository';
import { createTodo, getTodosByRepositoryId } from '@/lib/db';
import type { NextRequest } from 'next/server';

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
let repoId: string;

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);

  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  const repo = createRepository(db, {
    name: 'TestRepo',
    path: '/path/to/repo',
    cloneSource: 'local',
  });
  repoId = repo.id;
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

const asReq = (req: Request) => req as unknown as NextRequest;

describe('GET /api/repositories/:id/todos', () => {
  it('returns an empty array when no todos exist', async () => {
    const { GET } = await import('@/app/api/repositories/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/repositories/${repoId}/todos`)),
      { params: Promise.resolve({ id: repoId }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos).toEqual([]);
  });

  it('returns todos sorted by position', async () => {
    createTodo(db, repoId, { content: 'second', position: 1 });
    createTodo(db, repoId, { content: 'first', position: 0 });

    const { GET } = await import('@/app/api/repositories/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/repositories/${repoId}/todos`)),
      { params: Promise.resolve({ id: repoId }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos.map((t: { content: string }) => t.content)).toEqual(['first', 'second']);
  });

  it('includes the resolved repository name (Issue #900)', async () => {
    createTodo(db, repoId, { content: 'task', position: 0 });

    const { GET } = await import('@/app/api/repositories/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/repositories/${repoId}/todos`)),
      { params: Promise.resolve({ id: repoId }) },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos[0].repositoryName).toBe('TestRepo');
  });

  it('returns 404 for a non-existent repository', async () => {
    const { GET } = await import('@/app/api/repositories/[id]/todos/route');
    const res = await GET(
      asReq(new Request('http://localhost/api/repositories/nope/todos')),
      { params: Promise.resolve({ id: 'nope' }) },
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    db.close();
    const { GET } = await import('@/app/api/repositories/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/repositories/${repoId}/todos`)),
      { params: Promise.resolve({ id: repoId }) },
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/repositories/:id/todos', () => {
  const post = async (id: string, body: unknown) => {
    const { POST } = await import('@/app/api/repositories/[id]/todos/route');
    return POST(
      asReq(
        new Request(`http://localhost/api/repositories/${id}/todos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
      { params: Promise.resolve({ id }) },
    );
  };

  it('creates a todo', async () => {
    const res = await post(repoId, { content: 'Write tests' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.todo.content).toBe('Write tests');
    expect(data.todo.done).toBe(false);
    expect(data.todo.repositoryId).toBe(repoId);
    expect(data.todo.repositoryName).toBe('TestRepo');
    expect(data.todo.position).toBe(0);
  });

  it('trims content and auto-assigns the next position', async () => {
    await post(repoId, { content: 'one' });
    const res = await post(repoId, { content: '  two  ' });
    const data = await res.json();
    expect(data.todo.content).toBe('two');
    expect(data.todo.position).toBe(1);
  });

  it('returns 400 for empty content', async () => {
    const res = await post(repoId, { content: '   ' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('content');
  });

  it('returns 400 for content exceeding the max length', async () => {
    const res = await post(repoId, { content: 'a'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent repository', async () => {
    const res = await post('nope', { content: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/repositories/:id/todos/:todoId', () => {
  const patch = async (id: string, todoId: string, body: unknown) => {
    const { PATCH } = await import('@/app/api/repositories/[id]/todos/[todoId]/route');
    return PATCH(
      asReq(
        new Request(`http://localhost/api/repositories/${id}/todos/${todoId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
      { params: Promise.resolve({ id, todoId }) },
    );
  };

  it('toggles done', async () => {
    const todo = createTodo(db, repoId, { content: 'task', position: 0 });
    const res = await patch(repoId, todo.id, { done: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.done).toBe(true);
  });

  it('updates content', async () => {
    const todo = createTodo(db, repoId, { content: 'old', position: 0 });
    const res = await patch(repoId, todo.id, { content: 'new' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.content).toBe('new');
  });

  it('returns 400 when neither content nor done is provided', async () => {
    const todo = createTodo(db, repoId, { content: 'x', position: 0 });
    const res = await patch(repoId, todo.id, {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when done is not a boolean', async () => {
    const todo = createTodo(db, repoId, { content: 'x', position: 0 });
    const res = await patch(repoId, todo.id, { done: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent todo', async () => {
    const res = await patch(repoId, 'missing', { done: true });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the todo belongs to a different repository', async () => {
    const other = createRepository(db, {
      name: 'Other',
      path: '/path/to/other',
      cloneSource: 'local',
    });
    const todo = createTodo(db, other.id, { content: 'theirs', position: 0 });
    const res = await patch(repoId, todo.id, { done: true });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/repositories/:id/todos/:todoId', () => {
  const del = async (id: string, todoId: string) => {
    const { DELETE } = await import('@/app/api/repositories/[id]/todos/[todoId]/route');
    return DELETE(
      asReq(
        new Request(`http://localhost/api/repositories/${id}/todos/${todoId}`, {
          method: 'DELETE',
        }),
      ),
      { params: Promise.resolve({ id, todoId }) },
    );
  };

  it('deletes a todo', async () => {
    const todo = createTodo(db, repoId, { content: 'gone', position: 0 });
    const res = await del(repoId, todo.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(getTodosByRepositoryId(db, repoId)).toHaveLength(0);
  });

  it('returns 404 for a non-existent todo', async () => {
    const res = await del(repoId, 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent repository', async () => {
    const res = await del('nope', 'whatever');
    expect(res.status).toBe(404);
  });
});
