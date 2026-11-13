/**
 * Migration v72: the ask correlation ledger (Issue #4344, design
 * `docs/design/ask-attribution-4344.md` §3.1・§3.4).
 *
 * One row per `askId` a synchronous `commandmate ask` reserved: the destination
 * fixed at the send (worktree, instance, tool), how the send ended, the native
 * input and session the transcript reader saw the envelope in, and the
 * assistant rows of the completed turn that answered it, and whether that turn
 * also absorbed a background-task notice (`notified`, design §7 (a)).
 *
 * A new table only — nothing is backfilled. `worktree_id` follows the convention
 * `getWorktreeChildTables()` looks for, so a row follows a worktree id rename and
 * goes with its worktree. Holds no body: `body_digest` is a hash.
 *
 * The rollback drops the table, which forgets every reservation (an `ask` in
 * flight then reads `unmatched`).
 */

import type { Migration } from './runner';

export const v72_migrations: Migration[] = [
  {
    version: 72,
    name: 'ask-correlations',
    up: (db) => {
      db.exec(`
        CREATE TABLE ask_correlations (
          ask_id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          body_digest TEXT NOT NULL,
          send_state TEXT NOT NULL DEFAULT 'reserved'
            CHECK (send_state IN ('reserved', 'sent', 'not_sent', 'send_unknown')),
          sent_message_id TEXT,
          native_session_id TEXT,
          native_input_id TEXT,
          native_turn_key TEXT,
          assistant_message_ids TEXT NOT NULL DEFAULT '[]',
          turn_open_at_send INTEGER,
          notified INTEGER NOT NULL DEFAULT 0,
          attribution_state TEXT NOT NULL DEFAULT 'pending'
            CHECK (attribution_state IN ('pending', 'matched', 'ambiguous', 'unmatched')),
          reason TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX idx_ask_correlations_worktree_created
          ON ask_correlations (worktree_id, created_at);
      `);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS ask_correlations');
    },
  },
];
