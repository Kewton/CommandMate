/** Migration v32: Add composite index on chat_messages including role column (Issue #708).
 *
 * Existing idx_messages_archived (worktree_id, archived, timestamp DESC) does NOT
 * include the `role` column, causing SQLite to row-scan role='assistant'/'user'
 * filters in correlated subqueries (getWorktrees, getLastAssistantMessageAt, etc.).
 * This results in O(N * M) cost as chat_messages grows.
 *
 * Replaces idx_messages_archived with a composite index that includes role:
 *   (worktree_id, role, archived, timestamp DESC)
 *
 * Column order rationale:
 *   - worktree_id: highest selectivity, always equality-filtered
 *   - role: 2-value CHECK constraint, always equality-fixed in target queries
 *   - archived: equality-filtered (default 0)
 *   - timestamp DESC: suffix scan satisfies MAX(timestamp) and ORDER BY DESC LIMIT 1
 *
 * The old idx_messages_archived is dropped to avoid redundant write costs;
 * existing role-free queries (getMessages, getLastMessage, deleteAllMessages)
 * are covered by idx_messages_worktree_time(worktree_id, timestamp DESC).
 */

import type { Migration } from './runner';

export const v32_migrations: Migration[] = [
  {
    version: 32,
    name: 'add-messages-role-composite-index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_worktree_role_archived_time
          ON chat_messages(worktree_id, role, archived, timestamp DESC);
      `);
      db.exec('DROP INDEX IF EXISTS idx_messages_archived;');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_messages_worktree_role_archived_time;');
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_archived
          ON chat_messages(worktree_id, archived, timestamp DESC);
      `);
    },
  },
];
