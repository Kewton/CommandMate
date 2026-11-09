/**
 * Migration v70: which mem prompt an instance has already been shown (Issue #4226,
 * design `docs/design/mem-prompt-4226.md` §4.2).
 *
 * One row per (worktree, instance, code, scope): the scope is a hash of the storage
 * root and the branch, so going back to a branch or a root whose state did not change
 * prompts nothing again. The value is what the prompt was shown for: the instance's
 * incarnation, the conversation boundary and the fingerprint of the state. The rows
 * live in the database so "once for the same state" outlives a server restart.
 *
 * `worktree_id` follows the convention `getWorktreeChildTables()` looks for, so a row
 * follows a worktree id rename and goes with its worktree. Holds no body: no item text,
 * no branch name, no `--note`.
 *
 * Not named `mem_*`: it is #4226's table, not mem's store (#4221).
 *
 * The rollback drops the table, which forgets which prompts were shown.
 */

import type { Migration } from './runner';

export const v70_migrations: Migration[] = [
  {
    version: 70,
    name: 'suggestion-shown',
    up: (db) => {
      db.exec(`
        CREATE TABLE suggestion_shown (
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          code TEXT NOT NULL,
          instance_incarnation TEXT,
          boundary_id TEXT,
          scope_hash TEXT NOT NULL,
          fingerprint TEXT NOT NULL,
          shown_at INTEGER NOT NULL,
          PRIMARY KEY (worktree_id, instance_id, code, scope_hash)
        );
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS suggestion_shown');
    },
  },
];
