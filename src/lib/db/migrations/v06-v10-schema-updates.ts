/** Migration definitions for versions 6-10: link field, CLI tool ID, role change, session states, memos table. */

import type { Migration } from './runner';

export const v06_v10_migrations: Migration[] = [
  {
    version: 6,
    name: 'add-link-field',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN link TEXT DEFAULT NULL;
      `);
    },
    down: () => {
      console.log('No rollback needed for link field');
    }
  },
  {
    version: 7,
    name: 'add-cli-tool-id',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN cli_tool_id TEXT DEFAULT 'claude';
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_cli_tool
        ON worktrees(cli_tool_id);
      `);

      db.exec(`
        UPDATE worktrees SET cli_tool_id = 'claude' WHERE cli_tool_id IS NULL;
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_worktrees_cli_tool;
      `);

      console.log('No full rollback for cli_tool_id column (SQLite limitation)');
    }
  },
  {
    version: 8,
    name: 'change-role-claude-to-assistant',
    up: (db) => {
      db.exec(`
        CREATE TABLE chat_messages_new (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          summary TEXT,
          timestamp INTEGER NOT NULL,
          log_file_name TEXT,
          request_id TEXT,
          message_type TEXT DEFAULT 'normal',
          prompt_data TEXT,
          cli_tool_id TEXT DEFAULT 'claude',
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        INSERT INTO chat_messages_new
        SELECT
          id,
          worktree_id,
          CASE WHEN role = 'claude' THEN 'assistant' ELSE role END as role,
          content,
          summary,
          timestamp,
          log_file_name,
          request_id,
          message_type,
          prompt_data,
          cli_tool_id
        FROM chat_messages;
      `);

      db.exec(`DROP TABLE chat_messages;`);

      db.exec(`ALTER TABLE chat_messages_new RENAME TO chat_messages;`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_worktree
        ON chat_messages(worktree_id);
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp
        ON chat_messages(timestamp);
      `);

      console.log('Changed role constraint from "claude" to "assistant"');
      console.log('Updated existing messages with role="claude" to role="assistant"');
    },
    down: (db) => {
      db.exec(`
        CREATE TABLE chat_messages_new (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'claude')),
          content TEXT NOT NULL,
          summary TEXT,
          timestamp INTEGER NOT NULL,
          log_file_name TEXT,
          request_id TEXT,
          message_type TEXT DEFAULT 'normal',
          prompt_data TEXT,
          cli_tool_id TEXT DEFAULT 'claude',
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        INSERT INTO chat_messages_new
        SELECT
          id,
          worktree_id,
          CASE WHEN role = 'assistant' THEN 'claude' ELSE role END as role,
          content,
          summary,
          timestamp,
          log_file_name,
          request_id,
          message_type,
          prompt_data,
          cli_tool_id
        FROM chat_messages;
      `);

      db.exec(`DROP TABLE chat_messages;`);
      db.exec(`ALTER TABLE chat_messages_new RENAME TO chat_messages;`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_worktree
        ON chat_messages(worktree_id);
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp
        ON chat_messages(timestamp);
      `);

      console.log('Rolled back: Changed role constraint from "assistant" to "claude"');
    }
  },
  {
    version: 9,
    name: 'add-in-progress-message-id-to-session-states',
    up: (db) => {
      db.exec(`
        ALTER TABLE session_states ADD COLUMN in_progress_message_id TEXT DEFAULT NULL;
      `);

      console.log('Added in_progress_message_id column to session_states table');
    },
    down: () => {
      console.log('No full rollback for in_progress_message_id column (SQLite limitation)');
    }
  },
  {
    version: 10,
    name: 'add-worktree-memos-table',
    up: (db) => {
      db.exec(`
        CREATE TABLE worktree_memos (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Memo',
          content TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,

          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
          UNIQUE(worktree_id, position)
        );
      `);

      db.exec(`
        CREATE INDEX idx_worktree_memos_worktree
          ON worktree_memos(worktree_id, position);
      `);

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { randomUUID } = require('crypto') as typeof import('crypto');

      const worktrees = db.prepare(`
        SELECT id, memo FROM worktrees WHERE memo IS NOT NULL AND memo != ''
      `).all() as Array<{ id: string; memo: string }>;

      const insertStmt = db.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, 'Memo', ?, 0, ?, ?)
      `);

      const now = Date.now();
      for (const wt of worktrees) {
        insertStmt.run(randomUUID(), wt.id, wt.memo, now, now);
      }

      console.log(`Created worktree_memos table`);
      console.log(`Migrated ${worktrees.length} existing memos to new table`);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS worktree_memos');
      console.log('Dropped worktree_memos table');
    }
  },
];
