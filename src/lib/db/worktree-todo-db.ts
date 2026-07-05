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
 * A single ToDo item scoped to a worktree (branch).
 */
export interface WorktreeTodo {
  id: string;
  worktreeId: string;
  content: string;
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
  done: number;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * Map database row to WorktreeTodo model.
 */
function mapTodoRow(row: WorktreeTodoRow): WorktreeTodo {
  return {
    id: row.id,
    worktreeId: row.worktree_id,
    content: row.content,
    done: row.done === 1,
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
    SELECT id, worktree_id, content, done, position, created_at, updated_at
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
    SELECT id, worktree_id, content, done, position, created_at, updated_at
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
  }
): WorktreeTodo {
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO worktree_todos (id, worktree_id, content, done, position, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `);

  stmt.run(id, worktreeId, options.content, options.position, now, now);

  return {
    id,
    worktreeId,
    content: options.content,
    done: false,
    position: options.position,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  };
}

/**
 * Update an existing todo (content and/or done state).
 */
export function updateTodo(
  db: Database.Database,
  todoId: string,
  updates: {
    content?: string;
    done?: boolean;
  }
): void {
  const now = Date.now();
  const assignments: string[] = ['updated_at = ?'];
  const params: (string | number)[] = [now];

  if (updates.content !== undefined) {
    assignments.push('content = ?');
    params.push(updates.content);
  }

  if (updates.done !== undefined) {
    assignments.push('done = ?');
    params.push(updates.done ? 1 : 0);
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
