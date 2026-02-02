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
export const CURRENT_SCHEMA_VERSION = 15;

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
    down: () => {
      // No down migration needed - this is a data fix
      console.log('No rollback needed for repository path fix');
    }
  },
  {
    version: 4,
    name: 'add-favorite-field',
    up: (db) => {
      // Add favorite column to worktrees table
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN favorite INTEGER DEFAULT 0;
      `);

      // Create index on favorite for faster sorting
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_favorite
        ON worktrees(favorite DESC, updated_at DESC);
      `);
    },
    down: (db) => {
      // Remove favorite column (SQLite doesn't support DROP COLUMN directly)
      // We need to recreate the table without the favorite column
      db.exec(`
        -- Drop the index first
        DROP INDEX IF EXISTS idx_worktrees_favorite;

        -- Note: In production, you'd need to recreate the table without the favorite column
        -- This is a simplified down migration
      `);
    }
  },
  {
    version: 5,
    name: 'add-status-field',
    up: (db) => {
      // Add status column to worktrees table
      // Values: 'todo', 'doing', 'done', or NULL (not set)
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN status TEXT DEFAULT NULL;
      `);

      // Create index on status for faster filtering
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_status
        ON worktrees(status);
      `);
    },
    down: (rollbackDb) => {
      // Remove status index
      rollbackDb.exec(`
        DROP INDEX IF EXISTS idx_worktrees_status;
      `);
    }
  },
  {
    version: 6,
    name: 'add-link-field',
    up: (db) => {
      // Add link column to worktrees table for storing external URLs
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN link TEXT DEFAULT NULL;
      `);
    },
    down: () => {
      // No down migration needed - SQLite doesn't support DROP COLUMN directly
      console.log('No rollback needed for link field');
    }
  },
  {
    version: 7,
    name: 'add-cli-tool-id',
    up: (db) => {
      // Add cli_tool_id column to worktrees table
      // Default to 'claude' for backward compatibility
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN cli_tool_id TEXT DEFAULT 'claude';
      `);

      // Create index on cli_tool_id for faster filtering by tool type
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_cli_tool
        ON worktrees(cli_tool_id);
      `);

      // Update existing worktrees to explicitly set cli_tool_id to 'claude'
      // This ensures all existing worktrees have a non-null value
      db.exec(`
        UPDATE worktrees SET cli_tool_id = 'claude' WHERE cli_tool_id IS NULL;
      `);
    },
    down: (db) => {
      // Remove the index
      db.exec(`
        DROP INDEX IF EXISTS idx_worktrees_cli_tool;
      `);

      // Note: SQLite doesn't support DROP COLUMN directly
      // In production, you would need to recreate the table without cli_tool_id
      console.log('No full rollback for cli_tool_id column (SQLite limitation)');
    }
  },
  {
    version: 8,
    name: 'change-role-claude-to-assistant',
    up: (db) => {
      // SQLite doesn't support ALTER TABLE MODIFY COLUMN or changing CHECK constraints
      // We need to recreate the table with the new constraint

      // Create new table with updated role constraint
      db.exec(`
        CREATE TABLE chat_messages_new (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
          content TEXT NOT NULL,
          summary TEXT,
          timestamp INTEGER NOT NULL,
          log_file_name TEXT,
          request_id TEXT,
          message_type TEXT DEFAULT 'normal',
          prompt_data TEXT,
          cli_tool_id TEXT DEFAULT 'claude',
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      // Copy data from old table, converting 'claude' role to 'assistant'
      db.exec(`
        INSERT INTO chat_messages_new
        SELECT
          id,
          worktree_id,
          CASE WHEN role = 'claude' THEN 'assistant' ELSE role END as role,
          content,
          summary,
          timestamp,
          log_file_name,
          request_id,
          message_type,
          prompt_data,
          cli_tool_id
        FROM chat_messages;
      `);

      // Drop old table
      db.exec(`DROP TABLE chat_messages;`);

      // Rename new table to original name
      db.exec(`ALTER TABLE chat_messages_new RENAME TO chat_messages;`);

      // Recreate indexes
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_worktree
        ON chat_messages(worktree_id);
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp
        ON chat_messages(timestamp);
      `);

      console.log('✓ Changed role constraint from "claude" to "assistant"');
      console.log('✓ Updated existing messages with role="claude" to role="assistant"');
    },
    down: (db) => {
      // Rollback: change 'assistant' back to 'claude'
      db.exec(`
        CREATE TABLE chat_messages_new (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          role TEXT NOT NULL CHECK (role IN ('user', 'claude')),
          content TEXT NOT NULL,
          summary TEXT,
          timestamp INTEGER NOT NULL,
          log_file_name TEXT,
          request_id TEXT,
          message_type TEXT DEFAULT 'normal',
          prompt_data TEXT,
          cli_tool_id TEXT DEFAULT 'claude',
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        INSERT INTO chat_messages_new
        SELECT
          id,
          worktree_id,
          CASE WHEN role = 'assistant' THEN 'claude' ELSE role END as role,
          content,
          summary,
          timestamp,
          log_file_name,
          request_id,
          message_type,
          prompt_data,
          cli_tool_id
        FROM chat_messages;
      `);

      db.exec(`DROP TABLE chat_messages;`);
      db.exec(`ALTER TABLE chat_messages_new RENAME TO chat_messages;`);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_worktree
        ON chat_messages(worktree_id);
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_timestamp
        ON chat_messages(timestamp);
      `);

      console.log('✓ Rolled back: Changed role constraint from "assistant" to "claude"');
    }
  },
  {
    version: 9,
    name: 'add-in-progress-message-id-to-session-states',
    up: (db) => {
      // Add in_progress_message_id column to session_states table
      // This column tracks the message ID being actively updated during polling
      db.exec(`
        ALTER TABLE session_states ADD COLUMN in_progress_message_id TEXT DEFAULT NULL;
      `);

      console.log('✓ Added in_progress_message_id column to session_states table');
    },
    down: () => {
      // Note: SQLite doesn't support DROP COLUMN directly
      // In production, you would need to recreate the table without in_progress_message_id
      console.log('No full rollback for in_progress_message_id column (SQLite limitation)');
    }
  },
  {
    version: 10,
    name: 'add-worktree-memos-table',
    up: (db) => {
      // 1. Create worktree_memos table
      db.exec(`
        CREATE TABLE worktree_memos (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT 'Memo',
          content TEXT NOT NULL DEFAULT '',
          position INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,

          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE,
          UNIQUE(worktree_id, position)
        );
      `);

      // 2. Create index on worktree_id and position
      db.exec(`
        CREATE INDEX idx_worktree_memos_worktree
          ON worktree_memos(worktree_id, position);
      `);

      // 3. Migrate existing memo data from worktrees table
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { randomUUID } = require('crypto') as typeof import('crypto');

      const worktrees = db.prepare(`
        SELECT id, memo FROM worktrees WHERE memo IS NOT NULL AND memo != ''
      `).all() as Array<{ id: string; memo: string }>;

      const insertStmt = db.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, 'Memo', ?, 0, ?, ?)
      `);

      const now = Date.now();
      for (const wt of worktrees) {
        insertStmt.run(randomUUID(), wt.id, wt.memo, now, now);
      }

      console.log(`✓ Created worktree_memos table`);
      console.log(`✓ Migrated ${worktrees.length} existing memos to new table`);
    },
    down: (db) => {
      db.exec('DROP TABLE IF EXISTS worktree_memos');
      console.log('✓ Dropped worktree_memos table');
    }
  },
  {
    version: 11,
    name: 'add-viewed-tracking',
    up: (db) => {
      // G3: Add last_viewed_at column to worktrees table
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN last_viewed_at TEXT;
      `);

      // MF2: Add performance index for assistant message queries
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_assistant_latest
        ON chat_messages(worktree_id, role, timestamp DESC);
      `);

      console.log('✓ Added last_viewed_at column to worktrees table');
      console.log('✓ Created index for assistant message queries');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_chat_messages_assistant_latest');
      console.log('✓ Dropped idx_chat_messages_assistant_latest index');
      // Note: SQLite doesn't support DROP COLUMN directly
    }
  },
  {
    version: 12,
    name: 'add-external-apps-table',
    up: (db) => {
      // Issue #42: Create external_apps table for proxy routing
      db.exec(`
        CREATE TABLE IF NOT EXISTS external_apps (
          id TEXT PRIMARY KEY,

          -- Basic info
          name TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          description TEXT,

          -- Routing config
          path_prefix TEXT NOT NULL UNIQUE,
          target_port INTEGER NOT NULL,
          target_host TEXT DEFAULT 'localhost',

          -- App type
          app_type TEXT NOT NULL CHECK(app_type IN ('sveltekit', 'streamlit', 'nextjs', 'other')),

          -- WebSocket config
          websocket_enabled INTEGER DEFAULT 0,
          websocket_path_pattern TEXT,

          -- Status
          enabled INTEGER DEFAULT 1,

          -- Metadata
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Create indexes for performance
      db.exec(`
        CREATE INDEX idx_external_apps_path_prefix ON external_apps(path_prefix);
      `);

      db.exec(`
        CREATE INDEX idx_external_apps_enabled ON external_apps(enabled);
      `);

      console.log('✓ Created external_apps table');
      console.log('✓ Created indexes for external_apps');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_external_apps_enabled');
      db.exec('DROP INDEX IF EXISTS idx_external_apps_path_prefix');
      db.exec('DROP TABLE IF EXISTS external_apps');
      console.log('✓ Dropped external_apps table and indexes');
    }
  },
  {
    version: 13,
    name: 'rename-worktree-memo-to-description',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees RENAME COLUMN memo TO description;
      `);

      console.log('✓ Renamed worktrees.memo column to description');
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE worktrees RENAME COLUMN description TO memo;
      `);

      console.log('✓ Rolled back: Renamed worktrees.description column back to memo');
    }
  },
  {
    version: 14,
    name: 'add-repositories-and-clone-jobs-tables',
    up: (db) => {
      // Issue #71: Clone URL registration feature
      // Create repositories table for managing cloned repositories
      db.exec(`
        CREATE TABLE IF NOT EXISTS repositories (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          enabled INTEGER NOT NULL DEFAULT 1,
          clone_url TEXT,
          normalized_clone_url TEXT,
          clone_source TEXT CHECK(clone_source IN ('local', 'https', 'ssh')) DEFAULT 'local',
          is_env_managed INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
      `);

      // Create unique index on normalized_clone_url for duplicate prevention
      // NULL values are allowed (for local repos without clone URL)
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_normalized_clone_url
        ON repositories(normalized_clone_url)
        WHERE normalized_clone_url IS NOT NULL;
      `);

      // Create index on path for fast lookups
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_repositories_path
        ON repositories(path);
      `);

      // Create clone_jobs table for tracking clone operations
      db.exec(`
        CREATE TABLE IF NOT EXISTS clone_jobs (
          id TEXT PRIMARY KEY,
          clone_url TEXT NOT NULL,
          normalized_clone_url TEXT NOT NULL,
          target_path TEXT NOT NULL,
          repository_id TEXT,
          status TEXT NOT NULL CHECK(status IN ('pending', 'running', 'completed', 'failed', 'cancelled')) DEFAULT 'pending',
          pid INTEGER,
          progress INTEGER NOT NULL DEFAULT 0,
          error_category TEXT,
          error_code TEXT,
          error_message TEXT,
          started_at INTEGER,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,

          FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE SET NULL
        );
      `);

      // Create index on clone_jobs.status for querying active jobs
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clone_jobs_status
        ON clone_jobs(status);
      `);

      // Create index on clone_jobs.normalized_clone_url for duplicate prevention
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clone_jobs_normalized_clone_url
        ON clone_jobs(normalized_clone_url);
      `);

      console.log('✓ Created repositories table');
      console.log('✓ Created clone_jobs table');
      console.log('✓ Created indexes for repositories and clone_jobs');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_clone_jobs_normalized_clone_url');
      db.exec('DROP INDEX IF EXISTS idx_clone_jobs_status');
      db.exec('DROP TABLE IF EXISTS clone_jobs');
      db.exec('DROP INDEX IF EXISTS idx_repositories_path');
      db.exec('DROP INDEX IF EXISTS idx_repositories_normalized_clone_url');
      db.exec('DROP TABLE IF EXISTS repositories');
      console.log('✓ Dropped repositories and clone_jobs tables');
    }
  },
  {
    version: 15,
    name: 'add-initial-branch-column',
    up: (db) => {
      // Issue #111: Add initial_branch column to worktrees table
      // Stores the branch name at session start for mismatch detection
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN initial_branch TEXT;
      `);

      console.log('✓ Added initial_branch column to worktrees table');
    },
    down: (db) => {
      // SQLite doesn't support DROP COLUMN directly
      // Recreate table without initial_branch column
      db.exec(`
        -- 1. Create backup table without initial_branch
        CREATE TABLE worktrees_backup AS
        SELECT id, name, path, repository_path, repository_name, description,
               last_user_message, last_user_message_at, last_message_summary,
               favorite, status, link, cli_tool_id, updated_at, last_viewed_at
        FROM worktrees;

        -- 2. Drop original table
        DROP TABLE worktrees;

        -- 3. Recreate table without initial_branch
        CREATE TABLE worktrees (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          path TEXT NOT NULL UNIQUE,
          repository_path TEXT,
          repository_name TEXT,
          description TEXT,
          last_user_message TEXT,
          last_user_message_at INTEGER,
          last_message_summary TEXT,
          favorite INTEGER DEFAULT 0,
          status TEXT DEFAULT NULL,
          link TEXT DEFAULT NULL,
          cli_tool_id TEXT DEFAULT 'claude',
          updated_at INTEGER,
          last_viewed_at TEXT
        );

        -- 4. Restore data
        INSERT INTO worktrees (id, name, path, repository_path, repository_name,
               description, last_user_message, last_user_message_at, last_message_summary,
               favorite, status, link, cli_tool_id, updated_at, last_viewed_at)
        SELECT id, name, path, repository_path, repository_name,
               description, last_user_message, last_user_message_at, last_message_summary,
               favorite, status, link, cli_tool_id, updated_at, last_viewed_at
        FROM worktrees_backup;

        -- 5. Drop backup
        DROP TABLE worktrees_backup;

        -- 6. Recreate indexes
        CREATE INDEX IF NOT EXISTS idx_worktrees_updated_at
        ON worktrees(updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_worktrees_repository
        ON worktrees(repository_path);

        CREATE INDEX IF NOT EXISTS idx_worktrees_favorite
        ON worktrees(favorite DESC, updated_at DESC);

        CREATE INDEX IF NOT EXISTS idx_worktrees_status
        ON worktrees(status);

        CREATE INDEX IF NOT EXISTS idx_worktrees_cli_tool
        ON worktrees(cli_tool_id);
      `);

      console.log('✓ Removed initial_branch column from worktrees table');
    }
  }
];

/**
 * Helper function to find repository root from a worktree path
 * Walks up the directory tree to find .git directory
 * Handles both regular repos (.git directory) and worktrees (.git file)
 */
function findRepositoryRoot(worktreePath: string): string {
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Migration ${migration.version} failed:`, errorMessage);
      throw new Error(
        `Migration ${migration.version} (${migration.name}) failed: ${errorMessage}`
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
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      console.error(`✗ Rollback ${migration.version} failed:`, errorMessage);
      throw new Error(
        `Rollback of migration ${migration.version} failed: ${errorMessage}`
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
    const requiredTables = ['worktrees', 'chat_messages', 'session_states', 'schema_version', 'worktree_memos', 'external_apps', 'repositories', 'clone_jobs'];

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
