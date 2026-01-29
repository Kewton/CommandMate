/**
 * Database Migration: Add Prompt Support
 *
 * Adds message_type and prompt_data columns to chat_messages table
 * to support interactive prompt handling from Claude CLI
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'cm.db');

function migrate() {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Creating data directory: ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  try {
    console.log('Starting migration: Add prompt support to chat_messages table');
    console.log(`Database: ${DB_PATH}`);

    // Check if columns already exist
    const tableInfo = db.pragma(
      'table_info(chat_messages)'
    ) as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('message_type')) {
      console.log('⚠️  Migration already applied (message_type column exists)');
      console.log('Skipping migration.');
      return;
    }

    // Begin transaction
    db.exec('BEGIN TRANSACTION');

    // Add message_type column
    console.log('Adding message_type column...');
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN message_type TEXT DEFAULT 'normal';
    `);
    console.log('✓ Added message_type column');

    // Add prompt_data column
    console.log('Adding prompt_data column...');
    db.exec(`
      ALTER TABLE chat_messages
      ADD COLUMN prompt_data TEXT;
    `);
    console.log('✓ Added prompt_data column');

    // Create index for message_type
    console.log('Creating index on message_type...');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_type
      ON chat_messages(message_type, worktree_id);
    `);
    console.log('✓ Created index idx_messages_type');

    // Backfill existing messages with 'normal' type
    console.log('Backfilling existing messages...');
    const result = db.prepare(`
      UPDATE chat_messages
      SET message_type = 'normal'
      WHERE message_type IS NULL
    `).run();
    console.log(`✓ Backfilled ${result.changes} existing messages`);

    // Commit transaction
    db.exec('COMMIT');

    console.log('\n✅ Migration completed successfully!');
    console.log('\nSchema changes:');
    console.log('  - Added column: message_type (TEXT, default: "normal")');
    console.log('  - Added column: prompt_data (TEXT, nullable)');
    console.log('  - Added index: idx_messages_type (message_type, worktree_id)');
    console.log(`  - Updated ${result.changes} existing records`);
  } catch (error: any) {
    // Rollback on error
    try {
      db.exec('ROLLBACK');
    } catch (rollbackError) {
      // Ignore rollback errors
    }

    console.error('\n❌ Migration failed:', error.message);
    console.error(error);
    process.exit(1);
  } finally {
    db.close();
  }
}

// Run migration
migrate();
