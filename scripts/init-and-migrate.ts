/**
 * Initialize database and run migration
 */

import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { initDatabase } from '../src/lib/db';

const DATA_DIR = path.join(process.cwd(), 'data');
const DB_PATH = path.join(DATA_DIR, 'mcbd.db');

function main() {
  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    console.log(`Creating data directory: ${DATA_DIR}`);
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const db = new Database(DB_PATH);

  try {
    console.log('Initializing database schema...');
    initDatabase(db);
    console.log('✓ Database initialized');

    // Check if migration is needed
    const tableInfo = db.pragma('table_info(chat_messages)') as Array<{ name: string }>;
    const columnNames = tableInfo.map((col) => col.name);

    if (columnNames.includes('message_type')) {
      console.log('✓ Migration already applied');
      return;
    }

    console.log('\nApplying migration: Add prompt support');

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

    // Create index
    console.log('Creating index...');
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_type
      ON chat_messages(message_type, worktree_id);
    `);
    console.log('✓ Created index');

    // Backfill
    const result = db.prepare(`
      UPDATE chat_messages
      SET message_type = 'normal'
      WHERE message_type IS NULL
    `).run();
    console.log(`✓ Backfilled ${result.changes} messages`);

    // Commit
    db.exec('COMMIT');

    console.log('\n✅ Migration completed successfully!');
  } catch (error: any) {
    try {
      db.exec('ROLLBACK');
    } catch {}
    console.error('\n❌ Error:', error.message);
    throw error;
  } finally {
    db.close();
  }
}

main();
