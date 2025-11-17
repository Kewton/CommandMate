#!/usr/bin/env tsx
/**
 * Database initialization script
 * Creates db.sqlite with the required schema
 */

import Database from 'better-sqlite3';
import path from 'path';
import { initDatabase } from '../src/lib/db';

const dbPath = path.join(process.cwd(), 'db.sqlite');

console.log('Initializing database...');
console.log(`Database path: ${dbPath}`);

const db = new Database(dbPath);

try {
  initDatabase(db);
  console.log('✅ Database initialized successfully');

  // Verify tables were created
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
    .all() as Array<{ name: string }>;

  console.log('\nCreated tables:');
  tables.forEach((table) => {
    console.log(`  - ${table.name}`);
  });

  // Verify indexes were created
  const indexes = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' ORDER BY name")
    .all() as Array<{ name: string }>;

  console.log('\nCreated indexes:');
  indexes.forEach((index) => {
    console.log(`  - ${index.name}`);
  });
} catch (error) {
  console.error('❌ Failed to initialize database:', error);
  process.exit(1);
} finally {
  db.close();
}
