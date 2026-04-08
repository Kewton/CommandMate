/** Migration runner: schema versioning, execution, rollback, and validation logic. */

import Database from 'better-sqlite3';
import path from 'path';

/**
 * Migration definition
 */
export interface Migration {
  /** Migration version number (sequential) */
  version: number;

  /** Migration name/description */
  name: string;

  /** Forward migration function */
  up: (db: Database.Database) => void;

  /** Backward migration function (optional, for rollback) */
  down?: (db: Database.Database) => void;
}

/**
 * Current schema version
 * Increment this when adding new migrations
 */
export const CURRENT_SCHEMA_VERSION = 26;

/**
 * Get current schema version from database
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    const result = db.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number | null } | undefined;

    return result?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Initialize schema_version table
 */
export function initSchemaVersionTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

/**
 * Run all pending migrations
 *
 * @param db - Database instance
 * @param migrations - Array of migration definitions
 * @throws Error if migration fails
 */
export function runMigrations(db: Database.Database, migrations: Migration[]): void {
  // Initialize schema_version table
  initSchemaVersionTable(db);

  // Get current version
  const currentVersion = getCurrentVersion(db);

  console.log(`Current schema version: ${currentVersion}`);

  // Find pending migrations
  const pendingMigrations = migrations.filter(
    migration => migration.version > currentVersion
  );

  if (pendingMigrations.length === 0) {
    console.log('Schema is up to date');
    return;
  }

  console.log(`Found ${pendingMigrations.length} pending migration(s)`);

  // Run each pending migration in a transaction
  for (const migration of pendingMigrations) {
    console.log(`Applying migration ${migration.version}: ${migration.name}...`);

    try {
      // Run migration in transaction
      db.transaction(() => {
        // Execute migration
        migration.up(db);

        // Record migration in schema_version table
        db.prepare(`
          INSERT INTO schema_version (version, name, applied_at)
          VALUES (?, ?, ?)
        `).run(migration.version, migration.name, Date.now());
      })();

      console.log(`Migration ${migration.version} applied successfully`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Migration ${migration.version} failed:`, errorMessage);
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${errorMessage}`
      );
    }
  }

  console.log(`All migrations completed. Current version: ${getCurrentVersion(db)}`);
}

/**
 * Rollback migrations to a specific version
 *
 * @param db - Database instance
 * @param migrations - Array of migration definitions
 * @param targetVersion - Version to rollback to
 * @throws Error if rollback is not supported or fails
 */
export function rollbackMigrations(
  db: Database.Database,
  migrations: Migration[],
  targetVersion: number
): void {
  const currentVersion = getCurrentVersion(db);

  if (targetVersion >= currentVersion) {
    console.log('No rollback needed');
    return;
  }

  console.log(`Rolling back from version ${currentVersion} to ${targetVersion}...`);

  // Get migrations to rollback (in reverse order)
  const migrationsToRollback = migrations
    .filter(m => m.version > targetVersion && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version);

  for (const migration of migrationsToRollback) {
    if (!migration.down) {
      throw new Error(
        `Cannot rollback migration ${migration.version} (${migration.name}): ` +
        `no down() function defined`
      );
    }

    console.log(`Rolling back migration ${migration.version}: ${migration.name}...`);

    try {
      db.transaction(() => {
        // Execute rollback
        migration.down!(db);

        // Remove from schema_version table
        db.prepare('DELETE FROM schema_version WHERE version = ?')
          .run(migration.version);
      })();

      console.log(`Migration ${migration.version} rolled back`);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`Rollback ${migration.version} failed:`, errorMessage);
      throw new Error(
        `Rollback of migration ${migration.version} failed: ${errorMessage}`
      );
    }
  }

  console.log(`Rollback completed. Current version: ${getCurrentVersion(db)}`);
}

/**
 * Get migration history
 *
 * @param db - Database instance
 * @returns Array of applied migrations
 */
export function getMigrationHistory(db: Database.Database): Array<{
  version: number;
  name: string;
  appliedAt: Date;
}> {
  try {
    const rows = db.prepare(`
      SELECT version, name, applied_at
      FROM schema_version
      ORDER BY version ASC
    `).all() as Array<{
      version: number;
      name: string;
      applied_at: number;
    }>;

    return rows.map(row => ({
      version: row.version,
      name: row.name,
      appliedAt: new Date(row.applied_at)
    }));
  } catch {
    return [];
  }
}

/**
 * Validate database schema
 * Checks if all required tables exist
 *
 * @param db - Database instance
 * @returns true if schema is valid
 */
export function validateSchema(db: Database.Database): boolean {
  try {
    const tables = db.prepare(`
      SELECT name FROM sqlite_master
      WHERE type='table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all() as Array<{ name: string }>;

    const tableNames = tables.map(t => t.name);
    const requiredTables = ['worktrees', 'chat_messages', 'session_states', 'schema_version', 'worktree_memos', 'external_apps', 'repositories', 'clone_jobs', 'scheduled_executions', 'execution_logs', 'daily_reports', 'report_templates'];

    const missingTables = requiredTables.filter(t => !tableNames.includes(t));

    if (missingTables.length > 0) {
      console.error('Missing required tables:', missingTables.join(', '));
      return false;
    }

    return true;
  } catch (schemaError) {
    console.error('Schema validation failed:', schemaError);
    return false;
  }
}

/**
 * Helper function to find repository root from a worktree path
 * Walks up the directory tree to find .git directory
 * Handles both regular repos (.git directory) and worktrees (.git file)
 */
export function findRepositoryRoot(worktreePath: string): string {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('fs') as typeof import('fs');
  let currentPath = worktreePath;

  // Walk up the directory tree
  while (currentPath !== path.dirname(currentPath)) {
    const gitPath = path.join(currentPath, '.git');

    if (fs.existsSync(gitPath)) {
      const stats = fs.statSync(gitPath);

      if (stats.isDirectory()) {
        // This is a regular repository
        return currentPath;
      } else if (stats.isFile()) {
        // This is a git worktree - read the gitdir reference
        const gitFileContent = fs.readFileSync(gitPath, 'utf-8').trim();
        // Format: "gitdir: /path/to/main/repo/.git/worktrees/branch-name"
        const match = gitFileContent.match(/^gitdir:\s*(.+)$/);
        if (match) {
          // Extract main repo path from: /path/to/repo/.git/worktrees/branch-name
          const gitDir = match[1];
          // Remove "/.git/worktrees/branch-name" to get repo root
          const repoRoot = gitDir.split('/.git/')[0];
          return repoRoot;
        }
      }
    }

    currentPath = path.dirname(currentPath);
  }

  // If no .git found, return the worktree path itself
  return worktreePath;
}
