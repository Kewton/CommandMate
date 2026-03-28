/** Migration definitions for versions 11-15: viewed tracking, external apps, memo rename, repositories, initial branch. */

import type { Migration } from './runner';

export const v11_v15_migrations: Migration[] = [
  {
    version: 11,
    name: 'add-viewed-tracking',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN last_viewed_at TEXT;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_chat_messages_assistant_latest
        ON chat_messages(worktree_id, role, timestamp DESC);
      `);

      console.log('Added last_viewed_at column to worktrees table');
      console.log('Created index for assistant message queries');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_chat_messages_assistant_latest');
      console.log('Dropped idx_chat_messages_assistant_latest index');
    }
  },
  {
    version: 12,
    name: 'add-external-apps-table',
    up: (db) => {
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

      db.exec(`
        CREATE INDEX idx_external_apps_path_prefix ON external_apps(path_prefix);
      `);

      db.exec(`
        CREATE INDEX idx_external_apps_enabled ON external_apps(enabled);
      `);

      console.log('Created external_apps table');
      console.log('Created indexes for external_apps');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_external_apps_enabled');
      db.exec('DROP INDEX IF EXISTS idx_external_apps_path_prefix');
      db.exec('DROP TABLE IF EXISTS external_apps');
      console.log('Dropped external_apps table and indexes');
    }
  },
  {
    version: 13,
    name: 'rename-worktree-memo-to-description',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees RENAME COLUMN memo TO description;
      `);

      console.log('Renamed worktrees.memo column to description');
    },
    down: (db) => {
      db.exec(`
        ALTER TABLE worktrees RENAME COLUMN description TO memo;
      `);

      console.log('Rolled back: Renamed worktrees.description column back to memo');
    }
  },
  {
    version: 14,
    name: 'add-repositories-and-clone-jobs-tables',
    up: (db) => {
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

      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_repositories_normalized_clone_url
        ON repositories(normalized_clone_url)
        WHERE normalized_clone_url IS NOT NULL;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_repositories_path
        ON repositories(path);
      `);

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

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clone_jobs_status
        ON clone_jobs(status);
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_clone_jobs_normalized_clone_url
        ON clone_jobs(normalized_clone_url);
      `);

      console.log('Created repositories table');
      console.log('Created clone_jobs table');
      console.log('Created indexes for repositories and clone_jobs');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_clone_jobs_normalized_clone_url');
      db.exec('DROP INDEX IF EXISTS idx_clone_jobs_status');
      db.exec('DROP TABLE IF EXISTS clone_jobs');
      db.exec('DROP INDEX IF EXISTS idx_repositories_path');
      db.exec('DROP INDEX IF EXISTS idx_repositories_normalized_clone_url');
      db.exec('DROP TABLE IF EXISTS repositories');
      console.log('Dropped repositories and clone_jobs tables');
    }
  },
  {
    version: 15,
    name: 'add-initial-branch-column',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN initial_branch TEXT;
      `);

      console.log('Added initial_branch column to worktrees table');
    },
    down: (db) => {
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

      console.log('Removed initial_branch column from worktrees table');
    }
  },
];
