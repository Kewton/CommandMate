/** Migration definitions for versions 21-23: schedule index, archived messages, timer messages. */

import type { Migration } from './runner';

export const v21_v23_migrations: Migration[] = [
  {
    version: 21,
    name: 'add-scheduled-executions-worktree-enabled-index',
    up: (db) => {
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_scheduled_executions_worktree_enabled
          ON scheduled_executions(worktree_id, enabled);
      `);

      console.log('Created composite index idx_scheduled_executions_worktree_enabled');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_scheduled_executions_worktree_enabled');
      console.log('Dropped idx_scheduled_executions_worktree_enabled index');
    }
  },
  {
    version: 22,
    name: 'add-archived-column-to-chat-messages',
    up: (db) => {
      db.exec(`
        ALTER TABLE chat_messages ADD COLUMN archived INTEGER DEFAULT 0;
      `);

      db.exec(`
        UPDATE chat_messages SET archived = 0 WHERE archived IS NULL;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_messages_archived
          ON chat_messages(worktree_id, archived, timestamp DESC);
      `);

      console.log('Added archived column to chat_messages table');
      console.log('Created composite index idx_messages_archived');
    },
    down: () => {
      console.log('No rollback for archived column (SQLite limitation)');
    }
  },
  {
    version: 23,
    name: 'add-timer-messages-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE timer_messages (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          message TEXT NOT NULL,
          delay_ms INTEGER NOT NULL,
          scheduled_send_time INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
          sent_at INTEGER,
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );

        CREATE INDEX idx_timer_messages_worktree_status
          ON timer_messages(worktree_id, status);

        CREATE INDEX idx_timer_messages_status_scheduled
          ON timer_messages(status, scheduled_send_time);
      `);

      console.log('Created timer_messages table with indexes');
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_timer_messages_status_scheduled;
        DROP INDEX IF EXISTS idx_timer_messages_worktree_status;
        DROP TABLE IF EXISTS timer_messages;
      `);
    }
  }
];
