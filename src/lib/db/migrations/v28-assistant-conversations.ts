/** Migration v28: Add assistant conversation tables for Home Assistant Chat. */

import type { Migration } from './runner';

export const v28_migrations: Migration[] = [
  {
    version: 28,
    name: 'add-assistant-conversation-tables',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS assistant_conversations (
          id TEXT PRIMARY KEY,
          repository_id TEXT NOT NULL,
          cli_tool_id TEXT NOT NULL,
          working_directory TEXT NOT NULL,
          session_name TEXT,
          status TEXT NOT NULL DEFAULT 'idle',
          last_started_at INTEGER,
          last_stopped_at INTEGER,
          context_sent_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0,
          UNIQUE(repository_id, cli_tool_id),
          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_conversations_repository_tool
        ON assistant_conversations(repository_id, cli_tool_id);

        CREATE INDEX IF NOT EXISTS idx_assistant_conversations_status
        ON assistant_conversations(status, archived, updated_at DESC);

        CREATE TABLE IF NOT EXISTS assistant_messages (
          id TEXT PRIMARY KEY,
          conversation_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          summary TEXT,
          timestamp INTEGER NOT NULL,
          message_type TEXT NOT NULL DEFAULT 'normal',
          delivery_status TEXT CHECK(delivery_status IN ('pending', 'sent', 'failed')),
          archived INTEGER NOT NULL DEFAULT 0,
          FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_assistant_messages_conversation_time
        ON assistant_messages(conversation_id, timestamp DESC);

        CREATE INDEX IF NOT EXISTS idx_assistant_messages_delivery
        ON assistant_messages(conversation_id, delivery_status, timestamp DESC);

        CREATE TABLE IF NOT EXISTS assistant_session_states (
          conversation_id TEXT PRIMARY KEY,
          last_captured_line INTEGER NOT NULL DEFAULT 0,
          in_progress_message_id TEXT,
          FOREIGN KEY (conversation_id) REFERENCES assistant_conversations(id) ON DELETE CASCADE
        );
      `);
    },
    down: (db) => {
      db.exec(`
        DROP TABLE IF EXISTS assistant_session_states;
        DROP TABLE IF EXISTS assistant_messages;
        DROP TABLE IF EXISTS assistant_conversations;
      `);
    },
  },
];
