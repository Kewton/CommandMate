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
import { openDatabaseWithAbiRecovery } from './abi-recovery';
import { startAgentSessionCostSampler, stopAgentSessionCostSampler } from './agent-session-cost-sampler';
import { getEnv } from '@/lib/env';

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

    // Issue #1263: recover from a better-sqlite3 ABI mismatch (Node.js version switch)
    const db = openDatabaseWithAbiRecovery(dbPath);
    // Issue #294: Enable foreign key enforcement BEFORE migrations
    // This ensures ON DELETE CASCADE works correctly for all tables
    db.pragma('foreign_keys = ON');

    // Issue #1360: harden against SQLITE_BUSY when the same DB file is opened by
    // more than one process (e.g. a misconfigured worktree server sharing
    // CM_DB_PATH). WAL lets readers and a single writer coexist instead of
    // taking an exclusive lock, and busy_timeout makes a contended write wait
    // for the lock (up to 5s) rather than failing immediately with the default
    // busy_timeout of 0. Set before migrations so migration writes benefit too.
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');

    // Issue #1353: only publish the connection once its schema is verified.
    // Assigning before runMigrations() cached a database whose migrations had
    // thrown, so every later caller was handed it back without the failure —
    // the guard would fire once and be bypassed for the rest of the process.
    try {
      runMigrations(db);
    } catch (error) {
      db.close();
      throw error;
    }
    dbInstance = db;

    // Issue #2044: the agent cost ledger needs somebody to copy the in-memory
    // telemetry in before the pane that holds it is killed. This is the one
    // place that runs once per process, after the schema is verified, in every
    // process that has a database — and the sampler is a no-op wherever the
    // telemetry map is empty. It refuses to start under Vitest and unrefs its
    // timer, so nothing here holds a test or the CLI open.
    startAgentSessionCostSampler(db);
  }

  return dbInstance;
}

/**
 * Close the database connection
 * Mainly used for testing cleanup
 */
export function closeDbInstance(): void {
  if (dbInstance) {
    // Issue #2044: stop the sampler before the handle it writes through goes
    // away, or the next tick throws `The database connection is not open`.
    stopAgentSessionCostSampler();
    dbInstance.close();
    dbInstance = null;
  }
}
