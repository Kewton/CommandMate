/**
 * Database Migration System
 * Manages schema versioning and migrations for SQLite database
 */

import Database from 'better-sqlite3';
import path from 'path';
import { initDatabase } from './db';

/**
 * Current schema version
 * Increment this when adding new migrations
 */
export const CURRENT_SCHEMA_VERSION = 3;

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
 * Migration registry
 * All migrations should be added to this array in order
 */
const migrations: Migration[] = [
  {
    version: 1,
    name: 'initial-schema',
    up: (db) => {
      // Use existing initDatabase function for initial schema
      initDatabase(db);
    },
    down: (db) => {
      // Drop all tables (for testing purposes)
      db.exec(`DROP TABLE IF EXISTS session_states;`);
      db.exec(`DROP TABLE IF EXISTS chat_messages;`);
      db.exec(`DROP TABLE IF EXISTS worktrees;`);
    }
  },
  {
    version: 2,
    name: 'add-multi-repo-and-memo-support',
    up: (db) => {
      // 1. Add new columns to worktrees table
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN repository_path TEXT;
        ALTER TABLE worktrees ADD COLUMN repository_name TEXT;
        ALTER TABLE worktrees ADD COLUMN memo TEXT;
        ALTER TABLE worktrees ADD COLUMN last_user_message TEXT;
        ALTER TABLE worktrees ADD COLUMN last_user_message_at INTEGER;
      `);

      // 2. Create index on repository_path
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_repository
        ON worktrees(repository_path);
      `);

      // 3. Migrate existing data
      // Extract repository information from worktree paths
      const worktrees = db.prepare('SELECT id, path FROM worktrees').all() as Array<{
        id: string;
        path: string;
      }>;

      const updateStmt = db.prepare(`
        UPDATE worktrees
        SET repository_path = ?,
            repository_name = ?
        WHERE id = ?
      `);

      for (const wt of worktrees) {
        // Find repository root by looking for .git directory
        const repoPath = findRepositoryRoot(wt.path);
        const repoName = path.basename(repoPath);
        updateStmt.run(repoPath, repoName, wt.id);
      }

      // 4. Populate last_user_message from chat_messages
      const updateMessageStmt = db.prepare(`
        UPDATE worktrees
        SET last_user_message = ?,
            last_user_message_at = ?
        WHERE id = ?
      `);

      for (const wt of worktrees) {
        const latestUserMsg = db.prepare(`
          SELECT content, timestamp
          FROM chat_messages
          WHERE worktree_id = ? AND role = 'user'
          ORDER BY timestamp DESC
          LIMIT 1
        `).get(wt.id) as { content: string; timestamp: number } | undefined;

        if (latestUserMsg) {
          // Truncate message to 200 characters
          const truncatedMessage = latestUserMsg.content.substring(0, 200);
          updateMessageStmt.run(
            truncatedMessage,
            latestUserMsg.timestamp,
            wt.id
          );
        }
      }
    },
    down: (db) => {
      // Remove columns (SQLite doesn't support DROP COLUMN directly)
      // Instead, we recreate the table without the new columns
      db.exec(`
        -- Create backup table
        CREATE TABLE worktrees_backup AS
        SELECT id, name, path, last_message_summary, updated_at
        FROM worktrees;

        -- Drop original table
        DROP TABLE worktrees;

        -- Recreate original table
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          last_message_summary TEXT,
          updated_at INTEGER
        );

        -- Restore data
        INSERT INTO worktrees (id, name, path, last_message_summary, updated_at)
        SELECT id, name, path, last_message_summary, updated_at
        FROM worktrees_backup;

        -- Drop backup table
        DROP TABLE worktrees_backup;

        -- Drop index
        DROP INDEX IF EXISTS idx_worktrees_repository;
      `);
    }
  },
  {
    version: 3,
    name: 'fix-worktree-repository-paths',
    up: (db) => {
      // Fix repository paths for git worktrees
      // The previous migration incorrectly set repository_path to the worktree path itself
      // This migration re-runs the detection with the fixed findRepositoryRoot function

      const worktrees = db.prepare('SELECT id, path FROM worktrees').all() as Array<{
        id: string;
        path: string;
      }>;

      const updateStmt = db.prepare(`
        UPDATE worktrees
        SET repository_path = ?,
            repository_name = ?
        WHERE id = ?
      `);

      for (const wt of worktrees) {
        const repoPath = findRepositoryRoot(wt.path);
        const repoName = path.basename(repoPath);
        updateStmt.run(repoPath, repoName, wt.id);
      }
    },
    down: (db) => {
      // No down migration needed - this is a data fix
      console.log('No rollback needed for repository path fix');
    }
  }
];

/**
 * Helper function to find repository root from a worktree path
 * Walks up the directory tree to find .git directory
 * Handles both regular repos (.git directory) and worktrees (.git file)
 */
function findRepositoryRoot(worktreePath: string): string {
  const fs = require('fs');
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

/**
 * Get current schema version from database
 */
export function getCurrentVersion(db: Database.Database): number {
  try {
    const result = db.prepare(
      'SELECT MAX(version) as version FROM schema_version'
    ).get() as { version: number | null } | undefined;

    return result?.version ?? 0;
  } catch (error) {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Initialize schema_version table
 */
function initSchemaVersionTable(db: Database.Database): void {
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
 * @throws Error if migration fails
 */
export function runMigrations(db: Database.Database): void {
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
    console.log('✓ Schema is up to date');
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

      console.log(`✓ Migration ${migration.version} applied successfully`);
    } catch (error: any) {
      console.error(`✗ Migration ${migration.version} failed:`, error.message);
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${error.message}`
      );
    }
  }

  console.log(`✓ All migrations completed. Current version: ${getCurrentVersion(db)}`);
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

      console.log(`✓ Migration ${migration.version} rolled back`);
    } catch (error: any) {
      console.error(`✗ Rollback ${migration.version} failed:`, error.message);
      throw new Error(
        `Rollback of migration ${migration.version} failed: ${error.message}`
      );
    }
  }

  console.log(`✓ Rollback completed. Current version: ${getCurrentVersion(db)}`);
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
  } catch (error) {
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
    const requiredTables = ['worktrees', 'chat_messages', 'session_states', 'schema_version'];

    const missingTables = requiredTables.filter(t => !tableNames.includes(t));

    if (missingTables.length > 0) {
      console.error('Missing required tables:', missingTables.join(', '));
      return false;
    }

    return true;
  } catch (error) {
    console.error('Schema validation failed:', error);
    return false;
  }
}
