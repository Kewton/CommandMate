/**
 * Migration script: Add cli_tool_id column to chat_messages table
 *
 * This script adds the cli_tool_id column to the chat_messages table
 * and migrates existing messages to use the worktree's CLI tool ID.
 */

import Database from 'better-sqlite3';
import path from 'path';
import { getDbInstance } from '../src/lib/db-instance';
import { getWorktreeById } from '../src/lib/db';

const DB_PATH = process.env.MCBD_DB_PATH || path.join(process.cwd(), 'data', 'mcbd.db');

function runMigration() {
  console.log('[migrate-cli-tool-id] Starting migration...');
  console.log('[migrate-cli-tool-id] Database path:', DB_PATH);

  const db = getDbInstance();

  // Check if cli_tool_id column already exists
  const tableInfo = db.prepare(`PRAGMA table_info(chat_messages)`).all() as Array<{
    name: string;
    type: string;
  }>;

  const hasCliToolId = tableInfo.some((col) => col.name === 'cli_tool_id');

  if (hasCliToolId) {
    console.log('[migrate-cli-tool-id] Column cli_tool_id already exists. Checking if migration is needed...');

    // Check if there are any messages without cli_tool_id
    const messagesWithoutCliToolId = db
      .prepare(`SELECT COUNT(*) as count FROM chat_messages WHERE cli_tool_id IS NULL`)
      .get() as { count: number };

    if (messagesWithoutCliToolId.count === 0) {
      console.log('[migrate-cli-tool-id] All messages already have cli_tool_id. Migration complete.');
      return;
    }

    console.log(`[migrate-cli-tool-id] Found ${messagesWithoutCliToolId.count} messages without cli_tool_id. Migrating...`);
  } else {
    console.log('[migrate-cli-tool-id] Adding cli_tool_id column to chat_messages table...');

    // Add the column
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN cli_tool_id TEXT DEFAULT 'claude';
    `);

    // Create index for CLI tool filtering
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_cli_tool
      ON chat_messages(worktree_id, cli_tool_id, timestamp DESC);
    `);

    console.log('[migrate-cli-tool-id] Column added successfully.');
  }

  // Migrate existing messages to use the worktree's CLI tool ID
  console.log('[migrate-cli-tool-id] Migrating existing messages...');

  // Get all worktrees
  const worktrees = db.prepare(`SELECT id, cli_tool_id FROM worktrees`).all() as Array<{
    id: string;
    cli_tool_id: string | null;
  }>;

  console.log(`[migrate-cli-tool-id] Found ${worktrees.length} worktrees`);

  let migratedCount = 0;

  for (const worktree of worktrees) {
    const cliToolId = worktree.cli_tool_id || 'claude';

    // Update all messages for this worktree
    const result = db
      .prepare(`
        UPDATE chat_messages
        SET cli_tool_id = ?
        WHERE worktree_id = ? AND (cli_tool_id IS NULL OR cli_tool_id = '')
      `)
      .run(cliToolId, worktree.id);

    if (result.changes > 0) {
      console.log(`[migrate-cli-tool-id] Updated ${result.changes} messages for worktree ${worktree.id} to use ${cliToolId}`);
      migratedCount += result.changes;
    }
  }

  console.log(`[migrate-cli-tool-id] Migration complete. ${migratedCount} messages updated.`);
}

// Run migration
try {
  runMigration();
  console.log('[migrate-cli-tool-id] ✓ Migration successful');
  process.exit(0);
} catch (error) {
  console.error('[migrate-cli-tool-id] ✗ Migration failed:', error);
  process.exit(1);
}
