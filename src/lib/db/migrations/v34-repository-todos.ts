/** Migration v34: Add repository_todos table (global Home ToDo feature).
 *
 * A single, lightweight ToDo/memo widget on the Home page. Each ToDo item is
 * scoped to a repository (repositories.id) so the user can pick a target
 * repository and jot down checkbox-style tasks for it.
 *
 * Linkage uses repositories.id (the stable UUID primary key), mirroring how
 * the Home Assistant chat keys conversations by repository id. ToDos are
 * removed via ON DELETE CASCADE when the repository row is physically deleted.
 */

import type { Migration } from './runner';

export const v34_migrations: Migration[] = [
  {
    version: 34,
    name: 'add-repository-todos',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS repository_todos (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          content TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
        );
      `);
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_repository_todos_repo
          ON repository_todos(repository_id, position);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS repository_todos;');
    },
  },
];
