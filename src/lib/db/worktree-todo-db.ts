/**
 * Worktree ToDo database operations
 * CRUD + reorder operations for the worktree_todos table (migration v37).
 *
 * A lightweight, checkbox-style ToDo list scoped to a worktree (branch),
 * surfaced in the worktree detail screen (PC ActivityBar / mobile Tools tab).
 *
 * Mirrors the worktree_memos pattern (memo-db.ts): the table only stores
 * `worktree_id`, and rows are removed via ON DELETE CASCADE when the worktree
 * is deleted. Distinct from repository_todos (todo-db.ts), which is
 * repository-scoped (Home widget). Issue #1015.
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

/**
 * Progress state of a worktree ToDo (Issue #1032).
 * `todo` = not started, `doing` = in progress, `done` = completed.
 */
export type WorktreeTodoStatus = 'todo' | 'doing' | 'done';

/** All valid ToDo statuses, in cycle order (todo -> doing -> done). */
export const WORKTREE_TODO_STATUSES: readonly WorktreeTodoStatus[] = [
  'todo',
  'doing',
  'done',
];

/** Type guard for the three-state ToDo status. */
export function isWorktreeTodoStatus(value: unknown): value is WorktreeTodoStatus {
  return value === 'todo' || value === 'doing' || value === 'done';
}

/**
 * A single ToDo item scoped to a worktree (branch).
 *
 * `status` is the source of truth (Issue #1032); `done` is a derived
 * convenience flag (`status === 'done'`) retained for backward compatibility.
 */
export interface WorktreeTodo {
  id: string;
  worktreeId: string;
  content: string;
  /** Free-text supplementary notes for the item (Issue #1034); '' when unset. */
  detail: string;
  status: WorktreeTodoStatus;
  done: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database row type for worktree todos.
 */
type WorktreeTodoRow = {
  id: string;
  worktree_id: string;
  content: string;
  detail: string;
  done: number;
  status: string;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * Resolve a row's persisted status, falling back to the legacy `done` flag when
 * the value is missing or unrecognized (defensive; the column is NOT NULL with a
 * 'todo' default and backfilled at migration v38).
 */
function resolveStatus(rawStatus: string, done: number): WorktreeTodoStatus {
  if (isWorktreeTodoStatus(rawStatus)) {
    return rawStatus;
  }
  return done === 1 ? 'done' : 'todo';
}

/**
 * Map database row to WorktreeTodo model.
 */
function mapTodoRow(row: WorktreeTodoRow): WorktreeTodo {
  const status = resolveStatus(row.status, row.done);
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    content: row.content,
    detail: row.detail ?? '',
    status,
    done: status === 'done',
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get all todos for a worktree, sorted by position then creation time.
 */
export function getTodosByWorktreeId(
  db: Database.Database,
  worktreeId: string
): WorktreeTodo[] {
  const stmt = db.prepare(`
    SELECT id, worktree_id, content, detail, done, status, position, created_at, updated_at
    FROM worktree_todos
    WHERE worktree_id = ?
    ORDER BY position ASC, created_at ASC
  `);

  const rows = stmt.all(worktreeId) as WorktreeTodoRow[];
  return rows.map(mapTodoRow);
}

/**
 * Get a todo by ID.
 *
 * @returns Todo or null if not found.
 */
export function getTodoById(
  db: Database.Database,
  todoId: string
): WorktreeTodo | null {
  const stmt = db.prepare(`
    SELECT id, worktree_id, content, detail, done, status, position, created_at, updated_at
    FROM worktree_todos
    WHERE id = ?
  `);

  const row = stmt.get(todoId) as WorktreeTodoRow | undefined;
  return row ? mapTodoRow(row) : null;
}

/**
 * Create a new todo for a worktree.
 */
export function createTodo(
  db: Database.Database,
  worktreeId: string,
  options: {
    content: string;
    position: number;
    status?: WorktreeTodoStatus;
    detail?: string;
  }
): WorktreeTodo {
  const id = randomUUID();
  const now = Date.now();
  const status: WorktreeTodoStatus = options.status ?? 'todo';
  const done = status === 'done' ? 1 : 0;
  const detail = options.detail ?? '';

  const stmt = db.prepare(`
    INSERT INTO worktree_todos (id, worktree_id, content, detail, done, status, position, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(id, worktreeId, options.content, detail, done, status, options.position, now, now);

  return {
    id,
    worktreeId,
    content: options.content,
    detail,
    status,
    done: status === 'done',
    position: options.position,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Update an existing todo (content, status, and/or done state).
 *
 * `status` is authoritative. For backward compatibility a legacy `done` boolean
 * is still accepted and mapped to a status (`true` -> 'done', `false` -> 'todo')
 * only when `status` is not supplied. The persisted `done` column is always kept
 * consistent with the resolved status.
 */
export function updateTodo(
  db: Database.Database,
  todoId: string,
  updates: {
    content?: string;
    detail?: string;
    done?: boolean;
    status?: WorktreeTodoStatus;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now];

  if (updates.content !== undefined) {
    assignments.push('content = ?');
    params.push(updates.content);
  }

  if (updates.detail !== undefined) {
    assignments.push('detail = ?');
    params.push(updates.detail);
  }

  let resolvedStatus: WorktreeTodoStatus | undefined;
  if (updates.status !== undefined) {
    resolvedStatus = updates.status;
  } else if (updates.done !== undefined) {
    resolvedStatus = updates.done ? 'done' : 'todo';
  }

  if (resolvedStatus !== undefined) {
    assignments.push('status = ?');
    params.push(resolvedStatus);
    assignments.push('done = ?');
    params.push(resolvedStatus === 'done' ? 1 : 0);
  }

  params.push(todoId);

  const stmt = db.prepare(`
    UPDATE worktree_todos
    SET ${assignments.join(', ')}
    WHERE id = ?
  `);

  stmt.run(...params);
}

/**
 * Delete a todo by ID.
 */
export function deleteTodo(
  db: Database.Database,
  todoId: string
): void {
  const stmt = db.prepare(`
    DELETE FROM worktree_todos
    WHERE id = ?
  `);

  stmt.run(todoId);
}

/**
 * Reorder todos for a worktree.
 *
 * Uses a two-step approach (mirrors reorderMemos) so the operation stays safe
 * even if a UNIQUE (worktree_id, position) constraint is ever added:
 * 1. Offset all positions to negative values (temporary).
 * 2. Set new positions from the provided order.
 *
 * @param todoIds - Array of todo IDs in the desired order.
 */
export function reorderTodos(
  db: Database.Database,
  worktreeId: string,
  todoIds: string[]
): void {
  if (todoIds.length === 0) {
    return;
  }

  const now = Date.now();

  db.transaction(() => {
    const resetStmt = db.prepare(`
      UPDATE worktree_todos
      SET position = -1 - position
      WHERE id = ? AND worktree_id = ?
    `);

    for (const todoId of todoIds) {
      resetStmt.run(todoId, worktreeId);
    }

    const updateStmt = db.prepare(`
      UPDATE worktree_todos
      SET position = ?, updated_at = ?
      WHERE id = ? AND worktree_id = ?
    `);

    todoIds.forEach((todoId, index) => {
      updateStmt.run(index, now, todoId, worktreeId);
    });
  })();
}
