/**
 * Database instance singleton
 * Provides a shared database connection for API routes
 *
 * Issue #135: DB path resolution fix
 * Uses getEnv().CM_DB_PATH for consistent path handling across all install types
 */

import Database from 'better-sqlite3';
import path from 'path';
import { runMigrations } from './db-migrations';
import { getEnv } from './env';

let dbInstance: Database.Database | null = null;

/**
 * Get or create the database instance
 *
 * Issue #135: Now uses getEnv().CM_DB_PATH instead of direct DATABASE_PATH access
 * This ensures consistent DB path resolution for both global and local installs.
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
    // Issue #135: Use getEnv() for consistent DB path resolution
    const env = getEnv();
    const dbPath = env.CM_DB_PATH;

    // Ensure the database directory exists
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('fs') as typeof import('fs');
    const dir = path.dirname(dbPath);
    if (!fs.existsSync(dir)) {
      // SEC-003: Set directory permissions to 0o700 (owner only)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
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
