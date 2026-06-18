/**
 * Repository ToDo database operations
 * CRUD operations for the repository_todos table (migration v34).
 *
 * A lightweight, checkbox-style ToDo list scoped to a repository
 * (repositories.id), surfaced as a single widget on the Home page.
 */

import { randomUUID } from 'crypto';
import Database from 'better-sqlite3';

/**
 * A single ToDo item scoped to a repository.
 */
export interface RepositoryTodo {
  id: string;
  repositoryId: string;
  content: string;
  done: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database row type for repository todos.
 */
type RepositoryTodoRow = {
  id: string;
  repository_id: string;
  content: string;
  done: number;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * Map database row to RepositoryTodo model.
 */
function mapTodoRow(row: RepositoryTodoRow): RepositoryTodo {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    content: row.content,
    done: row.done === 1,
    position: row.position,
    createdAt: new Date(row.created_at),
    updatedAt: new Date(row.updated_at),
  };
}

/**
 * Get all todos for a repository, sorted by position then creation time.
 */
export function getTodosByRepositoryId(
  db: Database.Database,
  repositoryId: string
): RepositoryTodo[] {
  const stmt = db.prepare(`
    SELECT id, repository_id, content, done, position, created_at, updated_at
    FROM repository_todos
    WHERE repository_id = ?
    ORDER BY position ASC, created_at ASC
  `);

  const rows = stmt.all(repositoryId) as RepositoryTodoRow[];
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
): RepositoryTodo | null {
  const stmt = db.prepare(`
    SELECT id, repository_id, content, done, position, created_at, updated_at
    FROM repository_todos
    WHERE id = ?
  `);

  const row = stmt.get(todoId) as RepositoryTodoRow | undefined;
  return row ? mapTodoRow(row) : null;
}

/**
 * Create a new todo for a repository.
 */
export function createTodo(
  db: Database.Database,
  repositoryId: string,
  options: {
    content: string;
    position: number;
  }
): RepositoryTodo {
  const id = randomUUID();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO repository_todos (id, repository_id, content, done, position, created_at, updated_at)
    VALUES (?, ?, ?, 0, ?, ?, ?)
  `);

  stmt.run(id, repositoryId, options.content, options.position, now, now);

  return {
    id,
    repositoryId,
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
    UPDATE repository_todos
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
    DELETE FROM repository_todos
    WHERE id = ?
  `);

  stmt.run(todoId);
}
