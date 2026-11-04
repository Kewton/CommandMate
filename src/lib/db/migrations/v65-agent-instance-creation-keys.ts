/**
 * Migration v65: idempotency keys for creating an instance or saving a roster (Issue #4132).
 *
 * A write whose answer was lost cannot be told from another client's identical one by
 * comparing rows, so the request carries a key, written in the transaction that makes the
 * write. A NULL `request_fingerprint` is a key given up on (`settle`) or whose row has left
 * the roster: a request still on its way with that key makes nothing. Otherwise a NULL
 * `instance_id` is a roster PATCH that added not exactly one row. Design:
 * `docs/design/agent-roles-adapters.md` §15.
 *
 * `worktree_id` follows the convention `getWorktreeChildTables()` looks for, so a row
 * follows a worktree id rename and goes with its worktree. Holds no body and no secret.
 *
 * The rollback drops the table, which forgets recent keys and nothing else.
 */

import type { Migration } from './runner';

export const v65_migrations: Migration[] = [
  {
    version: 65,
    name: 'agent-instance-creation-keys',
    up: (db) => {
      db.exec(`
        CREATE TABLE agent_instance_creation_keys (
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          idempotency_key TEXT NOT NULL,
          instance_id TEXT,
          request_fingerprint TEXT,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (worktree_id, idempotency_key)
        );

        CREATE INDEX idx_agent_instance_creation_keys_created_at
          ON agent_instance_creation_keys(created_at);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS agent_instance_creation_keys');
    },
  },
];
