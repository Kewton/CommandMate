/** Migration definitions for versions 1-5: initial schema and basic table structure. */

import type { Migration } from './runner';
import { findRepositoryRoot } from './runner';
import { initDatabase } from '../db';
import path from 'path';

export const v01_v05_migrations: Migration[] = [
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
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN favorite INTEGER DEFAULT 0;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_favorite
        ON worktrees(favorite DESC, updated_at DESC);
      `);
    },
    down: (db) => {
      db.exec(`
        DROP INDEX IF EXISTS idx_worktrees_favorite;
      `);
    }
  },
  {
    version: 5,
    name: 'add-status-field',
    up: (db) => {
      db.exec(`
        ALTER TABLE worktrees ADD COLUMN status TEXT DEFAULT NULL;
      `);

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktrees_status
        ON worktrees(status);
      `);
    },
    down: (rollbackDb) => {
      rollbackDb.exec(`
        DROP INDEX IF EXISTS idx_worktrees_status;
      `);
    }
  },
];
