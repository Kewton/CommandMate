/**
 * Unit tests for repository_todos CRUD operations (todo-db.ts, migration v34).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { createRepository, updateRepository } from '@/lib/db/db-repository';
import {
  getTodosByRepositoryId,
  getTodoById,
  createTodo,
  updateTodo,
  deleteTodo,
} from '@/lib/db';

describe('todo-db', () => {
  let db: Database.Database;
  let repositoryId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);

    const repo = createRepository(db, {
      name: 'TestRepo',
      path: '/path/to/test-repo',
      cloneSource: 'local',
    });
    repositoryId = repo.id;
  });

  afterEach(() => {
    db.close();
  });

  it('creates the repository_todos table via migration v34', () => {
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all() as Array<{ name: string }>;
    expect(tables.map((t) => t.name)).toContain('repository_todos');
  });

  it('returns an empty list when no todos exist', () => {
    expect(getTodosByRepositoryId(db, repositoryId)).toEqual([]);
  });

  it('creates a todo with done=false by default', () => {
    const todo = createTodo(db, repositoryId, { content: 'Buy milk', position: 0 });
    expect(todo.id).toBeTruthy();
    expect(todo.repositoryId).toBe(repositoryId);
    expect(todo.content).toBe('Buy milk');
    expect(todo.done).toBe(false);
    expect(todo.position).toBe(0);
    expect(todo.createdAt).toBeInstanceOf(Date);
  });

  it('resolves the repository name via JOIN (Issue #900)', () => {
    const todo = createTodo(db, repositoryId, { content: 'task', position: 0 });
    // createTodo re-fetches so the returned object carries the name.
    expect(todo.repositoryName).toBe('TestRepo');
    expect(todo.repositoryDisplayName).toBeUndefined();

    const [listed] = getTodosByRepositoryId(db, repositoryId);
    expect(listed.repositoryName).toBe('TestRepo');

    const fetched = getTodoById(db, todo.id);
    expect(fetched?.repositoryName).toBe('TestRepo');
  });

  it('returns the repository display name when set (Issue #900)', () => {
    updateRepository(db, repositoryId, { displayName: 'My Repo' });
    const todo = createTodo(db, repositoryId, { content: 'task', position: 0 });
    expect(todo.repositoryName).toBe('TestRepo');
    expect(todo.repositoryDisplayName).toBe('My Repo');
  });

  it('reflects the latest repository name after a rename (Issue #900)', () => {
    const todo = createTodo(db, repositoryId, { content: 'task', position: 0 });
    expect(getTodoById(db, todo.id)?.repositoryName).toBe('TestRepo');

    updateRepository(db, repositoryId, { name: 'RenamedRepo' });

    expect(getTodoById(db, todo.id)?.repositoryName).toBe('RenamedRepo');
    expect(getTodosByRepositoryId(db, repositoryId)[0].repositoryName).toBe('RenamedRepo');
  });

  it('lists todos sorted by position', () => {
    createTodo(db, repositoryId, { content: 'C', position: 2 });
    createTodo(db, repositoryId, { content: 'A', position: 0 });
    createTodo(db, repositoryId, { content: 'B', position: 1 });

    const todos = getTodosByRepositoryId(db, repositoryId);
    expect(todos.map((t) => t.content)).toEqual(['A', 'B', 'C']);
  });

  it('scopes list to the given repository', () => {
    const other = createRepository(db, {
      name: 'Other',
      path: '/path/to/other',
      cloneSource: 'local',
    });
    createTodo(db, repositoryId, { content: 'mine', position: 0 });
    createTodo(db, other.id, { content: 'theirs', position: 0 });

    expect(getTodosByRepositoryId(db, repositoryId).map((t) => t.content)).toEqual(['mine']);
    expect(getTodosByRepositoryId(db, other.id).map((t) => t.content)).toEqual(['theirs']);
  });

  it('getTodoById returns null for a missing id', () => {
    expect(getTodoById(db, 'nope')).toBeNull();
  });

  it('updates content', () => {
    const todo = createTodo(db, repositoryId, { content: 'old', position: 0 });
    updateTodo(db, todo.id, { content: 'new' });
    expect(getTodoById(db, todo.id)?.content).toBe('new');
  });

  it('toggles done state', () => {
    const todo = createTodo(db, repositoryId, { content: 'task', position: 0 });
    updateTodo(db, todo.id, { done: true });
    expect(getTodoById(db, todo.id)?.done).toBe(true);
    updateTodo(db, todo.id, { done: false });
    expect(getTodoById(db, todo.id)?.done).toBe(false);
  });

  it('updates content and done together', () => {
    const todo = createTodo(db, repositoryId, { content: 'a', position: 0 });
    updateTodo(db, todo.id, { content: 'b', done: true });
    const updated = getTodoById(db, todo.id);
    expect(updated?.content).toBe('b');
    expect(updated?.done).toBe(true);
  });

  it('deletes a todo', () => {
    const todo = createTodo(db, repositoryId, { content: 'gone', position: 0 });
    deleteTodo(db, todo.id);
    expect(getTodoById(db, todo.id)).toBeNull();
    expect(getTodosByRepositoryId(db, repositoryId)).toHaveLength(0);
  });
});
