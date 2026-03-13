/**
 * Database initialization
 * Schema creation for all tables
 *
 * Issue #479: Extracted from db.ts for single-responsibility separation
 */

import Database from 'better-sqlite3';

/**
 * Initialize database schema
 */
export function initDatabase(db: Database.Database): void {
  // Create worktrees table
  db.exec(`
    CREATE TABLE IF NOT EXISTS worktrees (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      last_message_summary TEXT,
      updated_at INTEGER
    );
  `);

  // Create index for sorting by updated_at
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_worktrees_updated_at
    ON worktrees(updated_at DESC);
  `);

  // Create chat_messages table
  db.exec(`
    CREATE TABLE IF NOT EXISTS chat_messages (
      id TEXT PRIMARY KEY,
      worktree_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
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

  // Create indexes for chat_messages
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_worktree_time
    ON chat_messages(worktree_id, timestamp DESC);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_request_id
    ON chat_messages(request_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_type
    ON chat_messages(message_type, worktree_id);
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_cli_tool
    ON chat_messages(worktree_id, cli_tool_id, timestamp DESC);
  `);

  // Create session_states table
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_states (
      worktree_id TEXT NOT NULL,
      cli_tool_id TEXT NOT NULL DEFAULT 'claude',
      last_captured_line INTEGER DEFAULT 0,

      PRIMARY KEY (worktree_id, cli_tool_id),
      FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
    );
  `);
}
