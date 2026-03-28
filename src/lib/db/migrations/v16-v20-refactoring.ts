/** Migration definitions for versions 16-20: issue_no, scheduled executions, agent selection, vibe-local model/context. */

import type { Migration } from './runner';

export const v16_v20_migrations: Migration[] = [
  {
    version: 16,
    name: 'add-issue-no-to-external-apps',
    up: (db) => {
      db.exec(`
        ALTER TABLE external_apps ADD COLUMN issue_no INTEGER;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_external_apps_issue_no ON external_apps(issue_no);
      `);

      console.log('Added issue_no column to external_apps table');
      console.log('Created index idx_external_apps_issue_no');
    },
    down: (db) => {
      db.exec(`
        -- 1. Create backup table without issue_no
        CREATE TABLE external_apps_backup AS
        SELECT id, name, display_name, description, path_prefix, target_port,
               target_host, app_type, websocket_enabled, websocket_path_pattern,
               enabled, created_at, updated_at
        FROM external_apps;

        -- 2. Drop original table (this also drops indexes)
        DROP TABLE external_apps;

        -- 3. Recreate table without issue_no
        CREATE TABLE external_apps (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          display_name TEXT NOT NULL,
          description TEXT,
          path_prefix TEXT NOT NULL UNIQUE,
          target_port INTEGER NOT NULL,
          target_host TEXT DEFAULT 'localhost',
          app_type TEXT NOT NULL CHECK(app_type IN ('sveltekit', 'streamlit', 'nextjs', 'other')),
          websocket_enabled INTEGER DEFAULT 0,
          websocket_path_pattern TEXT,
          enabled INTEGER DEFAULT 1,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );

        -- 4. Restore data
        INSERT INTO external_apps (id, name, display_name, description, path_prefix,
               target_port, target_host, app_type, websocket_enabled, websocket_path_pattern,
               enabled, created_at, updated_at)
        SELECT id, name, display_name, description, path_prefix,
               target_port, target_host, app_type, websocket_enabled, websocket_path_pattern,
               enabled, created_at, updated_at
        FROM external_apps_backup;

        -- 5. Drop backup
        DROP TABLE external_apps_backup;

        -- 6. Recreate original indexes
        CREATE INDEX idx_external_apps_path_prefix ON external_apps(path_prefix);
        CREATE INDEX idx_external_apps_enabled ON external_apps(enabled);
      `);

      console.log('Removed issue_no column from external_apps table');
    }
  },
  {
    version: 17,
    name: 'add-scheduled-executions-and-execution-logs',
    up: (db) => {
      // [S3-002] Clean up orphan records BEFORE creating new tables with FK constraints
      db.exec(`
        DELETE FROM chat_messages WHERE worktree_id NOT IN (SELECT id FROM worktrees);
      `);
      db.exec(`
        DELETE FROM session_states WHERE worktree_id NOT IN (SELECT id FROM worktrees);
      `);
      db.exec(`
        DELETE FROM worktree_memos WHERE worktree_id NOT IN (SELECT id FROM worktrees);
      `);
      db.exec(`
        UPDATE clone_jobs SET repository_id = NULL
          WHERE repository_id IS NOT NULL AND repository_id NOT IN (SELECT id FROM repositories);
      `);

      db.exec(`
        CREATE TABLE scheduled_executions (
          id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL,
          cli_tool_id TEXT DEFAULT 'claude',
          name TEXT NOT NULL,
          message TEXT NOT NULL,
          cron_expression TEXT,
          enabled INTEGER DEFAULT 1,
          last_executed_at INTEGER,
          next_execute_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(worktree_id, name),
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        CREATE INDEX idx_scheduled_executions_worktree
          ON scheduled_executions(worktree_id);
      `);

      db.exec(`
        CREATE INDEX idx_scheduled_executions_enabled
          ON scheduled_executions(enabled);
      `);

      db.exec(`
        CREATE TABLE execution_logs (
          id TEXT PRIMARY KEY,
          schedule_id TEXT NOT NULL,
          worktree_id TEXT NOT NULL,
          message TEXT NOT NULL,
          result TEXT,
          exit_code INTEGER,
          status TEXT DEFAULT 'running' CHECK(status IN ('running', 'completed', 'failed', 'timeout', 'cancelled')),
          started_at INTEGER NOT NULL,
          completed_at INTEGER,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (schedule_id) REFERENCES scheduled_executions(id) ON DELETE CASCADE,
          FOREIGN KEY (worktree_id) REFERENCES worktrees(id) ON DELETE CASCADE
        );
      `);

      db.exec(`
        CREATE INDEX idx_execution_logs_schedule
          ON execution_logs(schedule_id);
      `);

      db.exec(`
        CREATE INDEX idx_execution_logs_worktree
          ON execution_logs(worktree_id);
      `);

      db.exec(`
        CREATE INDEX idx_execution_logs_status
          ON execution_logs(status);
      `);

      console.log('Cleaned up orphan records');
      console.log('Created scheduled_executions table');
      console.log('Created execution_logs table');
      console.log('Created indexes for schedule tables');
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_execution_logs_status');
      db.exec('DROP INDEX IF EXISTS idx_execution_logs_worktree');
      db.exec('DROP INDEX IF EXISTS idx_execution_logs_schedule');
      db.exec('DROP TABLE IF EXISTS execution_logs');
      db.exec('DROP INDEX IF EXISTS idx_scheduled_executions_enabled');
      db.exec('DROP INDEX IF EXISTS idx_scheduled_executions_worktree');
      db.exec('DROP TABLE IF EXISTS scheduled_executions');
      console.log('Dropped scheduled_executions and execution_logs tables');
    }
  },
  {
    version: 18,
    name: 'add-selected-agents-column',
    up: (db) => {
      // NOTE (R1-010): The literal values 'claude', 'codex' in the SQL CASE below
      // are fixed at migration time and do NOT sync with TypeScript CLI_TOOL_IDS.

      db.exec(`
        ALTER TABLE worktrees ADD COLUMN selected_agents TEXT;
      `);

      db.exec(`
        UPDATE worktrees SET selected_agents =
          CASE
            WHEN cli_tool_id NOT IN ('claude', 'codex')
            THEN json_array(cli_tool_id, 'claude')
            ELSE '["claude","codex"]'
          END;
      `);

      console.log('Added selected_agents column to worktrees table');
      console.log('Initialized selected_agents based on cli_tool_id');
    },
    down: () => {
      console.log('No rollback for selected_agents column (SQLite limitation)');
    }
  },
  {
    version: 19,
    name: 'add-vibe-local-model-column',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN vibe_local_model TEXT DEFAULT NULL;
      `);

      console.log('Added vibe_local_model column to worktrees table');
    },
    down: () => {
      console.log('No rollback for vibe_local_model column (SQLite limitation)');
    }
  },
  {
    version: 20,
    name: 'add-vibe-local-context-window-column',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN vibe_local_context_window INTEGER DEFAULT NULL;
      `);

      console.log('Added vibe_local_context_window column to worktrees table');
    },
    down: () => {
      console.log('No rollback for vibe_local_context_window column (SQLite limitation)');
    }
  },
];
