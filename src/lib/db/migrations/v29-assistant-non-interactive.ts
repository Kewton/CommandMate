/** Migration v29: Add non-interactive assistant execution support. */

import type { Migration } from './runner';

export const v29_migrations: Migration[] = [
  {
    version: 29,
    name: 'add-assistant-non-interactive-executions',
    up: (db) => {
      db.exec(`
        ALTER TABLE assistant_conversations
        ADD COLUMN execution_mode TEXT NOT NULL DEFAULT 'interactive';

        ALTER TABLE assistant_conversations
        ADD COLUMN resume_session_id TEXT;

        ALTER TABLE assistant_conversations
        ADD COLUMN last_execution_id TEXT;

        UPDATE assistant_conversations
        SET status = CASE
          WHEN status = 'idle' THEN 'stopped'
          ELSE status
        END;

        UPDATE assistant_conversations
        SET execution_mode = CASE
          WHEN cli_tool_id IN ('claude', 'codex') THEN 'non_interactive'
          ELSE 'interactive'
        END;

        CREATE TABLE IF NOT EXISTS assistant_executions (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          status TEXT NOT NULL,
          pid INTEGER,
          command_line TEXT NOT NULL,
          prompt_text TEXT NOT NULL,
          stdout_text TEXT,
          stderr_text TEXT,
          final_message_text TEXT,
          exit_code INTEGER,
          resume_session_id_before TEXT,
          resume_session_id_after TEXT,
          started_at INTEGER,
          finished_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_executions_conversation
        ON assistant_executions(conversation_id, created_at DESC);

        CREATE INDEX IF NOT EXISTS idx_assistant_executions_status
        ON assistant_executions(status, updated_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS assistant_executions;
      `);
    },
  },
];
