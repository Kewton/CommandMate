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
 *
 * `repositoryName` / `repositoryDisplayName` are resolved at read time by
 * JOINing `repositories` (Issue #900). The table itself stays normalized
 * (only `repository_id` is stored), so renames are reflected automatically.
 */
export interface RepositoryTodo {
  id: string;
  repositoryId: string;
  /** Repository `name` resolved via JOIN (always present, FK-guaranteed). */
  repositoryName: string;
  /** Repository `display_name` override; `undefined` when not set. */
  repositoryDisplayName?: string;
  content: string;
  done: boolean;
  position: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Database row type for repository todos.
 *
 * `repository_name` / `repository_display_name` come from the JOIN on
 * `repositories`, not the `repository_todos` table itself.
 */
type RepositoryTodoRow = {
  id: string;
  repository_id: string;
  repository_name: string;
  repository_display_name: string | null;
  content: string;
  done: number;
  position: number;
  created_at: number;
  updated_at: number;
};

/**
 * SELECT clause shared by todo read queries. Resolves the repository name at
 * read time so consumers (widget, future cross-repo views, API/CLI) all get a
 * human-readable name without denormalizing the table.
 */
const TODO_SELECT = `
  SELECT
    t.id,
    t.repository_id,
    r.name AS repository_name,
    r.display_name AS repository_display_name,
    t.content,
    t.done,
    t.position,
    t.created_at,
    t.updated_at
  FROM repository_todos t
  JOIN repositories r ON r.id = t.repository_id
`;

/**
 * Map database row to RepositoryTodo model.
 */
function mapTodoRow(row: RepositoryTodoRow): RepositoryTodo {
  return {
    id: row.id,
    repositoryId: row.repository_id,
    repositoryName: row.repository_name,
    repositoryDisplayName: row.repository_display_name || undefined,
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
    ${TODO_SELECT}
    WHERE t.repository_id = ?
    ORDER BY t.position ASC, t.created_at ASC
  `);

  const rows = stmt.all(repositoryId) as RepositoryTodoRow[];
  return rows.map(mapTodoRow);
}

/**
 * Get every todo across all repositories, for the global Home ToDo widget
 * (Issue #907). Unlike {@link getTodosByRepositoryId}, this is not scoped to a
 * single repository — the widget displays all repositories' todos at once.
 *
 * Ordered by the effective repository label (display name, falling back to
 * name, case-insensitive) so the cross-repo list is grouped per repository,
 * then by `position` / `created_at` within a repository, with `id` as a final
 * tiebreaker for fully deterministic ordering.
 */
export function getAllTodos(db: Database.Database): RepositoryTodo[] {
  const stmt = db.prepare(`
    ${TODO_SELECT}
    ORDER BY
      COALESCE(NULLIF(TRIM(r.display_name), ''), r.name) COLLATE NOCASE ASC,
      t.position ASC,
      t.created_at ASC,
      t.id ASC
  `);

  const rows = stmt.all() as RepositoryTodoRow[];
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
    ${TODO_SELECT}
    WHERE t.id = ?
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

  // Re-fetch so the returned todo carries the JOIN-resolved repository name
  // (Issue #900), keeping POST responses consistent with GET.
  const created = getTodoById(db, id);
  if (!created) {
    throw new Error(`Failed to load created todo '${id}'`);
  }
  return created;
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
