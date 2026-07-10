/**
 * API Route tests - Worktree (branch-scoped) ToDos (Issue #1015)
 *
 * Tests for:
 * - GET    /api/worktrees/:id/todos          - List todos for a worktree
 * - POST   /api/worktrees/:id/todos          - Create a todo (limit/length validation)
 * - PATCH  /api/worktrees/:id/todos          - Reorder todos
 * - PATCH  /api/worktrees/:id/todos/:todoId  - Update a todo (content/done)
 * - DELETE /api/worktrees/:id/todos/:todoId  - Delete a todo
 *
 * Mirrors the repository-todos route test conventions. Worktree routes use
 * synchronous `params` (matching the sibling memos routes), so params are
 * passed as plain objects (not Promises).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree } from '@/lib/db';
import { createTodo, getTodosByWorktreeId } from '@/lib/db/worktree-todo-db';
import { MAX_TODOS_PER_WORKTREE } from '@/config/todo-config';
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
const wtId = 'wt-1';

beforeEach(async () => {
  db = new Database(':memory:');
  runMigrations(db);

  const { setMockDb } = await import('@/lib/db/db-instance');
  setMockDb(db);

  upsertWorktree(db, {
    id: wtId,
    name: 'feature/foo',
    path: '/path/to/repo/feature-foo',
    repositoryPath: '/path/to/repo',
    repositoryName: 'repo',
  });
});

afterEach(async () => {
  const { closeDbInstance } = await import('@/lib/db/db-instance');
  closeDbInstance();
});

const asReq = (req: Request) => req as unknown as NextRequest;

describe('GET /api/worktrees/:id/todos', () => {
  it('returns an empty array when no todos exist', async () => {
    const { GET } = await import('@/app/api/worktrees/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/worktrees/${wtId}/todos`)),
      { params: { id: wtId } },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos).toEqual([]);
  });

  it('returns todos sorted by position', async () => {
    createTodo(db, wtId, { content: 'second', position: 1 });
    createTodo(db, wtId, { content: 'first', position: 0 });

    const { GET } = await import('@/app/api/worktrees/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/worktrees/${wtId}/todos`)),
      { params: { id: wtId } },
    );
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todos.map((t: { content: string }) => t.content)).toEqual(['first', 'second']);
  });

  it('does not leak todos from another worktree', async () => {
    upsertWorktree(db, {
      id: 'wt-2',
      name: 'feature/bar',
      path: '/path/to/repo/feature-bar',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
    createTodo(db, wtId, { content: 'mine', position: 0 });
    createTodo(db, 'wt-2', { content: 'theirs', position: 0 });

    const { GET } = await import('@/app/api/worktrees/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/worktrees/${wtId}/todos`)),
      { params: { id: wtId } },
    );
    const data = await res.json();
    expect(data.todos.map((t: { content: string }) => t.content)).toEqual(['mine']);
  });

  it('returns 404 for a non-existent worktree', async () => {
    const { GET } = await import('@/app/api/worktrees/[id]/todos/route');
    const res = await GET(
      asReq(new Request('http://localhost/api/worktrees/nope/todos')),
      { params: { id: 'nope' } },
    );
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error).toContain('not found');
  });

  it('returns 500 on database error', async () => {
    db.close();
    const { GET } = await import('@/app/api/worktrees/[id]/todos/route');
    const res = await GET(
      asReq(new Request(`http://localhost/api/worktrees/${wtId}/todos`)),
      { params: { id: wtId } },
    );
    expect(res.status).toBe(500);
  });
});

describe('POST /api/worktrees/:id/todos', () => {
  const post = async (id: string, body: unknown) => {
    const { POST } = await import('@/app/api/worktrees/[id]/todos/route');
    return POST(
      asReq(
        new Request(`http://localhost/api/worktrees/${id}/todos`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
      { params: { id } },
    );
  };

  it('creates a todo', async () => {
    const res = await post(wtId, { content: 'Write tests' });
    expect(res.status).toBe(201);
    const data = await res.json();
    expect(data.todo.content).toBe('Write tests');
    expect(data.todo.status).toBe('todo');
    expect(data.todo.done).toBe(false);
    expect(data.todo.worktreeId).toBe(wtId);
    expect(data.todo.position).toBe(0);
  });

  it('trims content and auto-assigns the next position', async () => {
    await post(wtId, { content: 'one' });
    const res = await post(wtId, { content: '  two  ' });
    const data = await res.json();
    expect(data.todo.content).toBe('two');
    expect(data.todo.position).toBe(1);
  });

  it('returns 400 for empty content', async () => {
    const res = await post(wtId, { content: '   ' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('content');
  });

  it('returns 400 for content exceeding the max length', async () => {
    const res = await post(wtId, { content: 'a'.repeat(2001) });
    expect(res.status).toBe(400);
  });

  it('returns 400 once the per-worktree todo limit is reached', async () => {
    for (let i = 0; i < MAX_TODOS_PER_WORKTREE; i++) {
      createTodo(db, wtId, { content: `t${i}`, position: i });
    }
    const res = await post(wtId, { content: 'one too many' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('Maximum todo limit');
  });

  it('returns 404 for a non-existent worktree', async () => {
    const res = await post('nope', { content: 'x' });
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/worktrees/:id/todos/:todoId', () => {
  const patch = async (id: string, todoId: string, body: unknown) => {
    const { PATCH } = await import('@/app/api/worktrees/[id]/todos/[todoId]/route');
    return PATCH(
      asReq(
        new Request(`http://localhost/api/worktrees/${id}/todos/${todoId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
      { params: { id, todoId } },
    );
  };

  it('toggles done', async () => {
    const todo = createTodo(db, wtId, { content: 'task', position: 0 });
    const res = await patch(wtId, todo.id, { done: true });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.done).toBe(true);
    expect(data.todo.status).toBe('done');
  });

  it('updates the status to doing', async () => {
    const todo = createTodo(db, wtId, { content: 'task', position: 0 });
    const res = await patch(wtId, todo.id, { status: 'doing' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.status).toBe('doing');
    expect(data.todo.done).toBe(false);
  });

  it('updates the status to done', async () => {
    const todo = createTodo(db, wtId, { content: 'task', position: 0 });
    const res = await patch(wtId, todo.id, { status: 'done' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.status).toBe('done');
    expect(data.todo.done).toBe(true);
  });

  it('returns 400 for an invalid status', async () => {
    const todo = createTodo(db, wtId, { content: 'task', position: 0 });
    const res = await patch(wtId, todo.id, { status: 'nope' });
    expect(res.status).toBe(400);
    const data = await res.json();
    expect(data.error).toContain('status');
  });

  it('updates content', async () => {
    const todo = createTodo(db, wtId, { content: 'old', position: 0 });
    const res = await patch(wtId, todo.id, { content: 'new' });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.todo.content).toBe('new');
  });

  it('returns 400 when neither content nor done is provided', async () => {
    const todo = createTodo(db, wtId, { content: 'x', position: 0 });
    const res = await patch(wtId, todo.id, {});
    expect(res.status).toBe(400);
  });

  it('returns 400 when done is not a boolean', async () => {
    const todo = createTodo(db, wtId, { content: 'x', position: 0 });
    const res = await patch(wtId, todo.id, { done: 'yes' });
    expect(res.status).toBe(400);
  });

  it('returns 400 for empty content', async () => {
    const todo = createTodo(db, wtId, { content: 'x', position: 0 });
    const res = await patch(wtId, todo.id, { content: '   ' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent todo', async () => {
    const res = await patch(wtId, 'missing', { done: true });
    expect(res.status).toBe(404);
  });

  it('returns 404 when the todo belongs to a different worktree', async () => {
    upsertWorktree(db, {
      id: 'wt-2',
      name: 'feature/bar',
      path: '/path/to/repo/feature-bar',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
    const todo = createTodo(db, 'wt-2', { content: 'theirs', position: 0 });
    const res = await patch(wtId, todo.id, { done: true });
    expect(res.status).toBe(404);
  });
});

describe('DELETE /api/worktrees/:id/todos/:todoId', () => {
  const del = async (id: string, todoId: string) => {
    const { DELETE } = await import('@/app/api/worktrees/[id]/todos/[todoId]/route');
    return DELETE(
      asReq(
        new Request(`http://localhost/api/worktrees/${id}/todos/${todoId}`, {
          method: 'DELETE',
        }),
      ),
      { params: { id, todoId } },
    );
  };

  it('deletes a todo', async () => {
    const todo = createTodo(db, wtId, { content: 'gone', position: 0 });
    const res = await del(wtId, todo.id);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(getTodosByWorktreeId(db, wtId)).toHaveLength(0);
  });

  it('returns 404 for a non-existent todo', async () => {
    const res = await del(wtId, 'missing');
    expect(res.status).toBe(404);
  });

  it('returns 404 for a non-existent worktree', async () => {
    const res = await del('nope', 'whatever');
    expect(res.status).toBe(404);
  });
});

describe('PATCH /api/worktrees/:id/todos (reorder)', () => {
  const reorder = async (id: string, body: unknown) => {
    const { PATCH } = await import('@/app/api/worktrees/[id]/todos/route');
    return PATCH(
      asReq(
        new Request(`http://localhost/api/worktrees/${id}/todos`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
      ),
      { params: { id } },
    );
  };

  it('reorders todos', async () => {
    const a = createTodo(db, wtId, { content: 'A', position: 0 });
    const b = createTodo(db, wtId, { content: 'B', position: 1 });
    const c = createTodo(db, wtId, { content: 'C', position: 2 });

    const res = await reorder(wtId, { todoIds: [c.id, a.id, b.id] });
    expect(res.status).toBe(200);

    expect(getTodosByWorktreeId(db, wtId).map((t) => t.content)).toEqual(['C', 'A', 'B']);
  });

  it('returns 400 when todoIds is not the complete set', async () => {
    const a = createTodo(db, wtId, { content: 'A', position: 0 });
    createTodo(db, wtId, { content: 'B', position: 1 });

    const res = await reorder(wtId, { todoIds: [a.id] });
    expect(res.status).toBe(400);
  });

  it('returns 400 for a non-array payload', async () => {
    createTodo(db, wtId, { content: 'A', position: 0 });
    const res = await reorder(wtId, { todoIds: 'nope' });
    expect(res.status).toBe(400);
  });

  it('returns 404 for a non-existent worktree', async () => {
    const res = await reorder('nope', { todoIds: [] });
    expect(res.status).toBe(404);
  });
});
