/**
 * Migration v33: agent instances (Issue #868).
 *
 * Extends session identity from `(worktree_id, cli_tool_id)` to
 * `(worktree_id, instance_id)` so a single worktree can run multiple instances
 * of the same CLI tool. Backward compatibility anchor: the PRIMARY instance has
 * `instance_id === cli_tool_id`, so every existing row is migrated with
 * `instance_id = cli_tool_id` and keeps behaving exactly as before.
 *
 * Three changes:
 *  1. session_states — rebuilt with an `instance_id` column and a new primary
 *     key `(worktree_id, instance_id)` (SQLite cannot alter a PK in place).
 *  2. chat_messages — gains an `instance_id` column (backfilled from cli_tool_id)
 *     plus an index for instance-scoped history lookups.
 *  3. agent_instances — new table holding the explicit instance roster per
 *     worktree, backfilled from each worktree's selected_agents (one primary
 *     instance per selected tool).
 */

import type { Migration } from './runner';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Parse a worktree's selected_agents JSON blob defensively.
 * Returns an ordered, de-duplicated list of CLI tool IDs, or an empty array when
 * the value is missing / malformed.
 */
function parseSelectedAgentsRaw(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    for (const value of parsed) {
      if (typeof value === 'string' && value.length > 0 && !seen.has(value)) {
        seen.add(value);
        result.push(value);
      }
    }
    return result;
  } catch {
    return [];
  }
}

export const v33_migrations: Migration[] = [
  {
    version: 33,
    name: 'add-agent-instances',
    up: (db) => {
      // ----------------------------------------------------------------------
      // 1. session_states: add instance_id + repoint primary key.
      //    SQLite cannot ALTER a PRIMARY KEY, so rebuild the table.
      // ----------------------------------------------------------------------
      db.exec(`
        CREATE TABLE session_states_new (
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL DEFAULT 'claude',
          instance_id TEXT NOT NULL DEFAULT 'claude',
          last_captured_line INTEGER DEFAULT 0,
          in_progress_message_id TEXT DEFAULT NULL,

          PRIMARY KEY (worktree_id, instance_id),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // Backfill instance_id = cli_tool_id (primary-instance anchor).
      // NOTE: long-lived databases can accumulate orphaned session_states rows
      // whose worktree was deleted (the pre-v33 table had a FK but rows may
      // predate it / FK enforcement was off at write time). The new table's
      // FOREIGN KEY would reject those orphans and abort the whole migration,
      // so we skip rows without a matching worktree. PRAGMA foreign_keys cannot
      // be toggled inside the migration transaction, hence the WHERE filter.
      db.exec(`
        INSERT INTO session_states_new
          (worktree_id, cli_tool_id, instance_id, last_captured_line, in_progress_message_id)
        SELECT
          worktree_id,
          COALESCE(cli_tool_id, 'claude'),
          COALESCE(cli_tool_id, 'claude'),
          last_captured_line,
          in_progress_message_id
        FROM session_states
        WHERE worktree_id IN (SELECT id FROM worktrees);
      `);

      db.exec(`DROP TABLE session_states;`);
      db.exec(`ALTER TABLE session_states_new RENAME TO session_states;`);

      // ----------------------------------------------------------------------
      // 2. chat_messages: add instance_id, backfill from cli_tool_id, index it.
      // ----------------------------------------------------------------------
      db.exec(`
        ALTER TABLE chat_messages ADD COLUMN instance_id TEXT DEFAULT NULL;
      `);

      db.exec(`
        UPDATE chat_messages
        SET instance_id = COALESCE(cli_tool_id, 'claude')
        WHERE instance_id IS NULL;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_instance
        ON chat_messages(worktree_id, instance_id, timestamp DESC);
      `);

      // ----------------------------------------------------------------------
      // 3. agent_instances: explicit per-worktree instance roster.
      // ----------------------------------------------------------------------
      db.exec(`
        CREATE TABLE agent_instances (
          worktree_id TEXT NOT NULL,
          instance_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          alias TEXT NOT NULL DEFAULT '',
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,

          PRIMARY KEY (worktree_id, instance_id),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        CREATE INDEX idx_agent_instances_worktree
        ON agent_instances(worktree_id, sort_order);
      `);

      // Backfill one primary instance per selected tool (instance_id = cli_tool_id).
      const worktrees = db.prepare(`
        SELECT id, selected_agents, cli_tool_id FROM worktrees
      `).all() as Array<{
        id: string;
        selected_agents: string | null;
        cli_tool_id: string | null;
      }>;

      const insertStmt = db.prepare(`
        INSERT OR IGNORE INTO agent_instances
          (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
        VALUES (?, ?, ?, '', ?, ?)
      `);

      const now = Date.now();
      let instanceCount = 0;
      for (const wt of worktrees) {
        let tools = parseSelectedAgentsRaw(wt.selected_agents);
        if (tools.length === 0) {
          // No explicit selection — fall back to the worktree's single CLI tool.
          tools = [wt.cli_tool_id || 'claude'];
        }
        tools.forEach((cliTool: CLIToolType | string, order: number) => {
          // Primary instance: instance_id === cli_tool_id.
          insertStmt.run(wt.id, cliTool, cliTool, order, now);
          instanceCount += 1;
        });
      }

      console.log('Rebuilt session_states with (worktree_id, instance_id) primary key');
      console.log('Added instance_id column + idx_messages_instance to chat_messages');
      console.log(`Created agent_instances table; backfilled ${instanceCount} primary instance(s)`);
    },
    down: (db) => {
      // Drop the new table.
      db.exec(`DROP INDEX IF EXISTS idx_agent_instances_worktree;`);
      db.exec(`DROP TABLE IF EXISTS agent_instances;`);

      // chat_messages: SQLite cannot drop a column pre-3.35; leave instance_id
      // in place (harmless) and just drop its index.
      db.exec(`DROP INDEX IF EXISTS idx_messages_instance;`);

      // session_states: rebuild back to (worktree_id, cli_tool_id) primary key,
      // collapsing any additional instances onto their primary row.
      db.exec(`
        CREATE TABLE session_states_old (
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL DEFAULT 'claude',
          last_captured_line INTEGER DEFAULT 0,
          in_progress_message_id TEXT DEFAULT NULL,

          PRIMARY KEY (worktree_id, cli_tool_id),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // Keep only primary-instance rows (instance_id === cli_tool_id) to avoid
      // primary-key collisions when discarding instance scoping.
      db.exec(`
        INSERT OR IGNORE INTO session_states_old
          (worktree_id, cli_tool_id, last_captured_line, in_progress_message_id)
        SELECT worktree_id, cli_tool_id, last_captured_line, in_progress_message_id
        FROM session_states
        WHERE instance_id = cli_tool_id;
      `);

      db.exec(`DROP TABLE session_states;`);
      db.exec(`ALTER TABLE session_states_old RENAME TO session_states;`);

      console.log('Rolled back agent_instances migration (v33)');
    }
  },
];
