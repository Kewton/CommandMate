/**
 * Database instance singleton
 * Provides a shared database connection for API routes
 */

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './db-migrations';

let dbInstance: Database.Database | null = null;

/**
 * Get or create the database instance
 *
 * @returns Singleton database instance
 *
 * @example
 * ```typescript
 * const db = getDbInstance();
 * const worktrees = getWorktrees(db);
 * ```
 */
export function getDbInstance(): Database.Database {
  if (!dbInstance) {
    const dbPath = process.env.DATABASE_PATH || path.join(process.cwd(), 'data', 'db.sqlite');

    // Ensure the database directory exists
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    dbInstance = new Database(dbPath);
    runMigrations(dbInstance);
  }

  return dbInstance;
}

/**
 * Close the database connection
 * Mainly used for testing cleanup
 */
export function closeDbInstance(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
