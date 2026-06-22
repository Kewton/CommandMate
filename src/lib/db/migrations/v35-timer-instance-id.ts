/** Migration v35: Add instance_id column to timer_messages (Issue #942).
 *
 * Timer (Issue #534) predates the AgentInstance system (Issue #869) and only
 * stored the backing CLI tool (`cli_tool_id`). To let a timer target a specific
 * registered agent instance — and route to that instance's tmux session via
 * `getSessionName(worktreeId, instanceId)` — we add a nullable `instance_id`
 * column.
 *
 * Backward compatibility: existing rows are backfilled with
 * `instance_id = cli_tool_id`, which is exactly the primary instance anchor
 * (`instanceId === cliTool`). New rows without an explicit instance also default
 * to the primary, so legacy single-session behavior is preserved byte-for-byte.
 */

import type { Migration } from './runner';

export const v35_migrations: Migration[] = [
  {
    version: 35,
    name: 'add-instance-id-to-timer-messages',
    up: (db) => {
      db.exec(`
        ALTER TABLE timer_messages ADD COLUMN instance_id TEXT;
      `);

      // Backfill existing timers: primary instance anchor (id === cli_tool_id).
      db.exec(`
        UPDATE timer_messages SET instance_id = cli_tool_id WHERE instance_id IS NULL;
      `);

      console.log('Added instance_id column to timer_messages table');
    },
    down: () => {
      // SQLite cannot drop a column without a table rebuild; no-op rollback
      // (mirrors the v22 archived-column migration).
      console.log('No rollback for instance_id column (SQLite limitation)');
    },
  },
];
