/**
 * Database Migration System - barrel file (Issue #575).
 * Re-exports all public API from migrations/ sub-modules.
 * The migrations array is NOT exported (DR2-004: internal implementation detail).
 */

import { migrations } from './migrations';
import {
  runMigrations as runMigrationsImpl,
  rollbackMigrations as rollbackMigrationsImpl,
} from './migrations/runner';
import type Database from 'better-sqlite3';

// Re-export types and constants
export type { Migration } from './migrations/runner';
export { CURRENT_SCHEMA_VERSION, getCurrentVersion, getMigrationHistory, validateSchema } from './migrations/runner';

/**
 * Run all pending migrations
 *
 * @param db - Database instance
 * @throws Error if migration fails
 */
export function runMigrations(db: Database.Database): void {
  runMigrationsImpl(db, migrations);
}

/**
 * Rollback migrations to a specific version
 *
 * @param db - Database instance
 * @param targetVersion - Version to rollback to
 * @throws Error if rollback is not supported or fails
 */
export function rollbackMigrations(
  db: Database.Database,
  targetVersion: number
): void {
  rollbackMigrationsImpl(db, migrations, targetVersion);
}
