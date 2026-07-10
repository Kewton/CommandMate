/**
 * Unit tests for worktree_todos CRUD + reorder operations
 * (worktree-todo-db.ts, migration v37, Issue #1015).
 *
 * Mirrors the worktree_memos DB test conventions. Covers CRUD, worktree scope
 * isolation, reorder, per-worktree limits, and the ON DELETE CASCADE behavior
 * when the parent worktree is deleted. The cascade test explicitly enables
 * `foreign_keys` on the raw better-sqlite3 connection ([S3-004]): unlike the
 * production singleton (db-instance.ts enables it before migrations), test
 * connections default to foreign_keys=OFF, so cascade would silently not fire.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, deleteWorktreesByIds } from '@/lib/db';
import {
  getTodosByWorktreeId,
  getTodoById,
  createTodo,
  updateTodo,
  deleteTodo,
  reorderTodos,
} from '@/lib/db/worktree-todo-db';

describe('worktree-todo-db', () => {
  let db: Database.Database;
  const worktreeId = 'wt-1';

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    upsertWorktree(db, {
      id: worktreeId,
      name: 'feature/foo',
      path: '/path/to/repo/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
  });

  afterEach(() => {
    db.close();
  });

  it('creates the worktree_todos table via migration v37', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('worktree_todos');
  });

  it('returns an empty list when no todos exist', () => {
    expect(getTodosByWorktreeId(db, worktreeId)).toEqual([]);
  });

  it('creates a todo with status "todo" (done=false) by default', () => {
    const todo = createTodo(db, worktreeId, { content: 'Buy milk', position: 0 });
    expect(todo.id).toBeTruthy();
    expect(todo.worktreeId).toBe(worktreeId);
    expect(todo.content).toBe('Buy milk');
    expect(todo.status).toBe('todo');
    expect(todo.done).toBe(false);
    expect(todo.position).toBe(0);
    expect(todo.createdAt).toBeInstanceOf(Date);
  });

  it('creates a todo with an explicit status', () => {
    const todo = createTodo(db, worktreeId, { content: 'WIP', position: 0, status: 'doing' });
    expect(todo.status).toBe('doing');
    expect(todo.done).toBe(false);
    expect(getTodoById(db, todo.id)?.status).toBe('doing');
  });

  it('lists todos sorted by position', () => {
    createTodo(db, worktreeId, { content: 'C', position: 2 });
    createTodo(db, worktreeId, { content: 'A', position: 0 });
    createTodo(db, worktreeId, { content: 'B', position: 1 });

    const todos = getTodosByWorktreeId(db, worktreeId);
    expect(todos.map((t) => t.content)).toEqual(['A', 'B', 'C']);
  });

  it('scopes the list to the given worktree (no cross-worktree leakage)', () => {
    upsertWorktree(db, {
      id: 'wt-2',
      name: 'feature/bar',
      path: '/path/to/repo/feature-bar',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    });
    createTodo(db, worktreeId, { content: 'mine', position: 0 });
    createTodo(db, 'wt-2', { content: 'theirs', position: 0 });

    expect(getTodosByWorktreeId(db, worktreeId).map((t) => t.content)).toEqual(['mine']);
    expect(getTodosByWorktreeId(db, 'wt-2').map((t) => t.content)).toEqual(['theirs']);
  });

  it('getTodoById returns null for a missing id', () => {
    expect(getTodoById(db, 'nope')).toBeNull();
  });

  it('getTodoById returns the created todo', () => {
    const todo = createTodo(db, worktreeId, { content: 'task', position: 0 });
    expect(getTodoById(db, todo.id)?.content).toBe('task');
    expect(getTodoById(db, todo.id)?.worktreeId).toBe(worktreeId);
  });

  it('updates content', () => {
    const todo = createTodo(db, worktreeId, { content: 'old', position: 0 });
    updateTodo(db, todo.id, { content: 'new' });
    expect(getTodoById(db, todo.id)?.content).toBe('new');
  });

  it('toggles done state (legacy) and keeps status consistent', () => {
    const todo = createTodo(db, worktreeId, { content: 'task', position: 0 });
    updateTodo(db, todo.id, { done: true });
    let updated = getTodoById(db, todo.id);
    expect(updated?.done).toBe(true);
    expect(updated?.status).toBe('done');
    updateTodo(db, todo.id, { done: false });
    updated = getTodoById(db, todo.id);
    expect(updated?.done).toBe(false);
    expect(updated?.status).toBe('todo');
  });

  it('cycles through the three statuses and derives done', () => {
    const todo = createTodo(db, worktreeId, { content: 'task', position: 0 });

    updateTodo(db, todo.id, { status: 'doing' });
    let updated = getTodoById(db, todo.id);
    expect(updated?.status).toBe('doing');
    expect(updated?.done).toBe(false);

    updateTodo(db, todo.id, { status: 'done' });
    updated = getTodoById(db, todo.id);
    expect(updated?.status).toBe('done');
    expect(updated?.done).toBe(true);

    updateTodo(db, todo.id, { status: 'todo' });
    updated = getTodoById(db, todo.id);
    expect(updated?.status).toBe('todo');
    expect(updated?.done).toBe(false);
  });

  it('prefers status over the legacy done flag when both are provided', () => {
    const todo = createTodo(db, worktreeId, { content: 'task', position: 0 });
    updateTodo(db, todo.id, { status: 'doing', done: true });
    const updated = getTodoById(db, todo.id);
    expect(updated?.status).toBe('doing');
    expect(updated?.done).toBe(false);
  });

  it('updates content and done together', () => {
    const todo = createTodo(db, worktreeId, { content: 'a', position: 0 });
    updateTodo(db, todo.id, { content: 'b', done: true });
    const updated = getTodoById(db, todo.id);
    expect(updated?.content).toBe('b');
    expect(updated?.done).toBe(true);
  });

  it('deletes a todo', () => {
    const todo = createTodo(db, worktreeId, { content: 'gone', position: 0 });
    deleteTodo(db, todo.id);
    expect(getTodoById(db, todo.id)).toBeNull();
    expect(getTodosByWorktreeId(db, worktreeId)).toHaveLength(0);
  });

  describe('reorderTodos', () => {
    it('applies a new order', () => {
      const a = createTodo(db, worktreeId, { content: 'A', position: 0 });
      const b = createTodo(db, worktreeId, { content: 'B', position: 1 });
      const c = createTodo(db, worktreeId, { content: 'C', position: 2 });

      reorderTodos(db, worktreeId, [c.id, a.id, b.id]);

      const todos = getTodosByWorktreeId(db, worktreeId);
      expect(todos.map((t) => t.content)).toEqual(['C', 'A', 'B']);
      expect(todos.map((t) => t.position)).toEqual([0, 1, 2]);
    });

    it('is a no-op for an empty id list', () => {
      createTodo(db, worktreeId, { content: 'A', position: 0 });
      expect(() => reorderTodos(db, worktreeId, [])).not.toThrow();
      expect(getTodosByWorktreeId(db, worktreeId).map((t) => t.content)).toEqual(['A']);
    });
  });

  describe('ON DELETE CASCADE (worktree deletion, [S3-004])', () => {
    it('removes the worktree_todos rows when the parent worktree is deleted', () => {
      // [S3-004]: raw test connections default foreign_keys=OFF; enable it so the
      // cascade actually fires (production db-instance.ts enables it pre-migration).
      db.pragma('foreign_keys = ON');

      const todo = createTodo(db, worktreeId, { content: 'cascade me', position: 0 });
      expect(getTodoById(db, todo.id)).not.toBeNull();

      deleteWorktreesByIds(db, [worktreeId]);

      const rows = db
        .prepare('SELECT * FROM worktree_todos WHERE worktree_id = ?')
        .all(worktreeId);
      expect(rows).toHaveLength(0);
    });
  });
});
