/**
 * Issue #1151: same-directory branch switch must NOT CASCADE-delete history.
 *
 * A worktree's primary-key ID is derived from its branch name
 * (`generateWorktreeId`). Checking out a different branch in the same directory
 * changes the ID even though the on-disk path is unchanged. The previous sync
 * logic treated the vanished old ID as a "removed" worktree and hard-deleted its
 * row, which CASCADE-deleted every child table (chat history, memos, todos,
 * timers, schedules, execution logs, agent instances, session states).
 *
 * These tests reproduce the branch-switch flow against a real in-memory SQLite
 * database with `PRAGMA foreign_keys = ON` (mirroring production
 * `db-instance.ts`) and assert that child data is preserved across branch
 * switches while genuinely-removed worktrees are still cleaned up.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  upsertWorktree,
  createMessage,
  getWorktreeById,
  migrateWorktreeIdPreservingChildren,
} from '@/lib/db';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  syncWorktreesToDB,
  pruneStaleRepositoryWorktrees,
  repositoryExistsOnDisk,
} from '@/lib/git/worktrees';
import type { Worktree } from '@/types/models';

const REPO_PATH = '/repos/anvil';
const WORKTREE_PATH = '/repos/anvil'; // develop lives in the primary worktree dir

function makeWorktree(id: string, branch: string): Worktree {
  return {
    id,
    name: branch,
    branch,
    path: WORKTREE_PATH,
    repositoryPath: REPO_PATH,
    repositoryName: 'anvil',
  };
}

/**
 * Insert exactly one row into every table that has an ON DELETE CASCADE FK to
 * `worktrees(id)`, so we can assert the full blast radius of a CASCADE.
 */
function seedChildData(db: Database.Database, worktreeId: string): void {
  const now = Date.now();

  // chat_messages (via the production helper, to track schema drift)
  createMessage(db, {
    worktreeId,
    role: 'user',
    content: `hello from ${worktreeId}`,
    timestamp: new Date(now),
    messageType: 'normal',
  });

  // worktree_memos
  db.prepare(
    `INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`memo-${worktreeId}`, worktreeId, 'Memo', 'note', 0, now, now);

  // worktree_todos
  db.prepare(
    `INSERT INTO worktree_todos (id, worktree_id, content, done, position, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(`todo-${worktreeId}`, worktreeId, 'do the thing', 0, 0, now, now);

  // agent_instances
  db.prepare(
    `INSERT INTO agent_instances (worktree_id, instance_id, cli_tool_id, alias, sort_order, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(worktreeId, 'claude', 'claude', 'primary', 0, now);

  // session_states
  db.prepare(
    `INSERT INTO session_states (worktree_id, cli_tool_id, instance_id, last_captured_line)
     VALUES (?, ?, ?, ?)`
  ).run(worktreeId, 'claude', 'claude', 42);

  // timer_messages
  db.prepare(
    `INSERT INTO timer_messages (id, worktree_id, cli_tool_id, message, delay_ms, scheduled_send_time, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(`timer-${worktreeId}`, worktreeId, 'claude', 'ping', 1000, now + 1000, 'pending', now);

  // scheduled_executions + execution_logs (log references the schedule)
  const scheduleId = `sched-${worktreeId}`;
  db.prepare(
    `INSERT INTO scheduled_executions (id, worktree_id, cli_tool_id, name, message, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(scheduleId, worktreeId, 'claude', 'nightly', 'run', now, now);
  db.prepare(
    `INSERT INTO execution_logs (id, schedule_id, worktree_id, message, started_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(`log-${worktreeId}`, scheduleId, worktreeId, 'run', now, now);
}

const CHILD_TABLES = [
  'chat_messages',
  'worktree_memos',
  'worktree_todos',
  'agent_instances',
  'session_states',
  'timer_messages',
  'scheduled_executions',
  'execution_logs',
];

/** Count child rows keyed to a worktree ID across every CASCADE child table. */
function countChildData(db: Database.Database, worktreeId: string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of CHILD_TABLES) {
    const row = db
      .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE worktree_id = ?`)
      .get(worktreeId) as { c: number };
    counts[table] = row.c;
  }
  return counts;
}

function totalChildRows(db: Database.Database): number {
  return CHILD_TABLES.reduce((sum, table) => {
    const row = db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number };
    return sum + row.c;
  }, 0);
}

describe('Issue #1151: branch-switch history preservation', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // Mirror production (src/lib/db/db-instance.ts): enforce FK so CASCADE fires.
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  describe('upsertWorktree renames stale same-path rows instead of deleting', () => {
    it('preserves every child table when the branch changes in the same directory', () => {
      upsertWorktree(db, makeWorktree('anvil-develop', 'develop'));
      seedChildData(db, 'anvil-develop');

      const before = countChildData(db, 'anvil-develop');
      for (const table of CHILD_TABLES) {
        expect(before[table], `${table} should be seeded`).toBe(1);
      }

      // Branch switch: develop -> feature-x (same path, new ID)
      upsertWorktree(db, makeWorktree('anvil-feature-x', 'feature-x'));

      // Old ID no longer exists as a row, but its data moved to the new ID.
      expect(getWorktreeById(db, 'anvil-develop')).toBeNull();
      const after = countChildData(db, 'anvil-feature-x');
      for (const table of CHILD_TABLES) {
        expect(after[table], `${table} should be carried over`).toBe(1);
      }
      // Nothing was CASCADE-deleted: total child rows unchanged.
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length);

      // The single row keeps the new branch identity.
      const wt = getWorktreeById(db, 'anvil-feature-x');
      expect(wt?.path).toBe(WORKTREE_PATH);
      expect(wt?.branch).toBe('feature-x');
    });

    it('does not touch child data when a genuinely new path is added', () => {
      upsertWorktree(db, makeWorktree('anvil-develop', 'develop'));
      seedChildData(db, 'anvil-develop');

      // Different directory => different worktree, no rename.
      upsertWorktree(db, {
        id: 'anvil-feature-y',
        name: 'feature-y',
        branch: 'feature-y',
        path: '/repos/anvil-feature-y',
        repositoryPath: REPO_PATH,
        repositoryName: 'anvil',
      });

      expect(getWorktreeById(db, 'anvil-develop')).not.toBeNull();
      expect(countChildData(db, 'anvil-develop').chat_messages).toBe(1);
    });
  });

  describe('syncWorktreesToDB prunes by path, not by branch-derived ID', () => {
    it('preserves history across a develop -> feature -> develop cycle', () => {
      // Initial sync on develop, then user works and accumulates history.
      syncWorktreesToDB(db, [makeWorktree('anvil-develop', 'develop')]);
      seedChildData(db, 'anvil-develop');
      expect(countChildData(db, 'anvil-develop').chat_messages).toBe(1);

      // git checkout feature-x; a sync runs (server restart / manual sync).
      syncWorktreesToDB(db, [makeWorktree('anvil-feature-x', 'feature-x')]);
      // History followed the directory to the new ID; nothing deleted.
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length);
      expect(countChildData(db, 'anvil-feature-x').chat_messages).toBe(1);
      expect(getWorktreeById(db, 'anvil-develop')).toBeNull();

      // git checkout develop again; sync runs.
      syncWorktreesToDB(db, [makeWorktree('anvil-develop', 'develop')]);

      // The original develop history is intact and reachable again.
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length);
      const restored = countChildData(db, 'anvil-develop');
      for (const table of CHILD_TABLES) {
        expect(restored[table], `${table} preserved after A->B->A`).toBe(1);
      }
      const wt = getWorktreeById(db, 'anvil-develop');
      expect(wt?.branch).toBe('develop');
    });

    it('still cleans up (CASCADE) a worktree that is genuinely removed from disk', () => {
      // Two worktrees in the repo: primary (develop) + a feature dir.
      const develop = makeWorktree('anvil-develop', 'develop');
      const feature: Worktree = {
        id: 'anvil-feature-z',
        name: 'feature-z',
        branch: 'feature-z',
        path: '/repos/anvil-feature-z',
        repositoryPath: REPO_PATH,
        repositoryName: 'anvil',
      };
      syncWorktreesToDB(db, [develop, feature]);
      seedChildData(db, 'anvil-develop');
      seedChildData(db, 'anvil-feature-z');
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length * 2);

      // `git worktree remove` deletes the feature directory. Next sync only
      // reports the develop path.
      syncWorktreesToDB(db, [develop]);

      // The removed worktree and its children are gone (CASCADE), develop's
      // data is untouched.
      expect(getWorktreeById(db, 'anvil-feature-z')).toBeNull();
      expect(countChildData(db, 'anvil-feature-z').chat_messages).toBe(0);
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length);
      expect(countChildData(db, 'anvil-develop').chat_messages).toBe(1);
    });

    it('does not delete anything when the scan is empty (guard)', () => {
      syncWorktreesToDB(db, [makeWorktree('anvil-develop', 'develop')]);
      seedChildData(db, 'anvil-develop');

      const result = syncWorktreesToDB(db, []);

      expect(result.deletedIds).toEqual([]);
      expect(getWorktreeById(db, 'anvil-develop')).not.toBeNull();
      expect(totalChildRows(db)).toBe(CHILD_TABLES.length);
    });
  });

  describe('migrateWorktreeIdPreservingChildren', () => {
    it('is a no-op when old and new IDs are identical', () => {
      upsertWorktree(db, makeWorktree('anvil-develop', 'develop'));
      seedChildData(db, 'anvil-develop');

      db.transaction(() => {
        migrateWorktreeIdPreservingChildren(db, 'anvil-develop', 'anvil-develop');
      })();

      expect(countChildData(db, 'anvil-develop').chat_messages).toBe(1);
    });

    it('is a no-op when the source ID does not exist', () => {
      upsertWorktree(db, makeWorktree('anvil-develop', 'develop'));

      db.transaction(() => {
        migrateWorktreeIdPreservingChildren(db, 'missing', 'anvil-develop');
      })();

      expect(getWorktreeById(db, 'anvil-develop')).not.toBeNull();
    });

    it('merges into the destination without error on a (path-UNIQUE-guarded) ID collision', () => {
      // Force two rows to coexist by using distinct paths, then migrate old->new
      // where new already exists. Destination data wins; source folds in.
      upsertWorktree(db, {
        id: 'wt-old',
        name: 'old',
        branch: 'old',
        path: '/repos/anvil-old',
        repositoryPath: REPO_PATH,
        repositoryName: 'anvil',
      });
      upsertWorktree(db, {
        id: 'wt-new',
        name: 'new',
        branch: 'new',
        path: '/repos/anvil-new',
        repositoryPath: REPO_PATH,
        repositoryName: 'anvil',
      });
      seedChildData(db, 'wt-old');
      seedChildData(db, 'wt-new');

      db.transaction(() => {
        migrateWorktreeIdPreservingChildren(db, 'wt-old', 'wt-new');
      })();

      // Old row is gone; destination retains at least its own data.
      expect(getWorktreeById(db, 'wt-old')).toBeNull();
      expect(getWorktreeById(db, 'wt-new')).not.toBeNull();
      expect(countChildData(db, 'wt-new').chat_messages).toBeGreaterThanOrEqual(1);
      // No rows left orphaned on the old ID.
      expect(countChildData(db, 'wt-old').chat_messages).toBe(0);
    });
  });
});

/**
 * Issue #1349: a repository whose directory is deleted or de-gitified makes
 * `scanWorktrees` return `[]` (git exit 128). The repository then never appears
 * in the scan handed to `syncWorktreesToDB`, so its worktree rows are never
 * pruned and survive forever as ghost rows in the sidebar. `syncWorktreesToDB`'s
 * global early-return only fires when *every* repository is empty, so a single
 * vanished repository among healthy ones is never reconciled.
 *
 * `pruneStaleRepositoryWorktrees` is the global-sync reconciliation step. These
 * tests exercise it against a real in-memory SQLite database plus real temp
 * directories, asserting that:
 *   - a vanished directory (or a de-gitified one) is pruned (CASCADE),
 *   - a directory that still exists is NEVER pruned even when the scan is empty
 *     (transient git error / network-drive blip → keep, do not destroy history),
 *   - a repository present in the current scan is treated as alive regardless of
 *     the filesystem, and other repositories are left untouched.
 */
describe('Issue #1349: pruneStaleRepositoryWorktrees', () => {
  let db: Database.Database;
  const tempDirs: string[] = [];

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    // Mirror production (src/lib/db/db-instance.ts): enforce FK so CASCADE fires.
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
    for (const dir of tempDirs.splice(0)) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  /** Create a real temp repo directory (optionally with a `.git` entry). */
  function makeRepoDir(withGit = true): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-1349-'));
    if (withGit) fs.mkdirSync(path.join(dir, '.git'));
    tempDirs.push(dir);
    return dir;
  }

  function repoWorktree(repoPath: string, id: string, branch: string): Worktree {
    return {
      id,
      name: branch,
      branch,
      path: repoPath,
      repositoryPath: repoPath,
      repositoryName: path.basename(repoPath),
    };
  }

  describe('repositoryExistsOnDisk', () => {
    it('is true only when both the directory and its .git exist', () => {
      const withGit = makeRepoDir(true);
      const noGit = makeRepoDir(false);

      expect(repositoryExistsOnDisk(withGit)).toBe(true);
      expect(repositoryExistsOnDisk(noGit)).toBe(false); // de-gitified
      expect(repositoryExistsOnDisk('/definitely/not/here/cm-1349')).toBe(false);
      expect(repositoryExistsOnDisk('')).toBe(false);
    });
  });

  it('prunes worktree rows (CASCADE) when the repository directory is deleted', () => {
    const repo = makeRepoDir();
    syncWorktreesToDB(db, [repoWorktree(repo, 'r-main', 'main')]);
    seedChildData(db, 'r-main');
    expect(getWorktreeById(db, 'r-main')).not.toBeNull();
    expect(totalChildRows(db)).toBe(CHILD_TABLES.length);

    // Directory deleted → next global sync scans it to [] (absent from live set).
    fs.rmSync(repo, { recursive: true, force: true });
    const deleted = pruneStaleRepositoryWorktrees(db, []);

    expect(deleted).toContain('r-main');
    expect(getWorktreeById(db, 'r-main')).toBeNull();
    // Child data is CASCADE-deleted with the row.
    expect(countChildData(db, 'r-main').chat_messages).toBe(0);
    expect(totalChildRows(db)).toBe(0);
  });

  it('prunes when the directory exists but .git was removed (de-gitified)', () => {
    const repo = makeRepoDir();
    syncWorktreesToDB(db, [repoWorktree(repo, 'r-main', 'main')]);

    fs.rmSync(path.join(repo, '.git'), { recursive: true, force: true });
    const deleted = pruneStaleRepositoryWorktrees(db, []);

    expect(deleted).toContain('r-main');
    expect(getWorktreeById(db, 'r-main')).toBeNull();
  });

  it('does NOT prune when the directory + .git still exist but the scan is empty', () => {
    // Conservative guard: a present repository that merely errored in git (or a
    // transiently-invisible network drive whose mount point is still present)
    // must never be pruned.
    const repo = makeRepoDir();
    syncWorktreesToDB(db, [repoWorktree(repo, 'r-main', 'main')]);
    seedChildData(db, 'r-main');

    const deleted = pruneStaleRepositoryWorktrees(db, []);

    expect(deleted).toEqual([]);
    expect(getWorktreeById(db, 'r-main')).not.toBeNull();
    expect(totalChildRows(db)).toBe(CHILD_TABLES.length);
  });

  it('prunes only the vanished repository, leaving live repositories untouched', () => {
    const gone = makeRepoDir();
    const alive = makeRepoDir();
    syncWorktreesToDB(db, [
      repoWorktree(gone, 'gone-main', 'main'),
      repoWorktree(alive, 'alive-main', 'main'),
    ]);
    seedChildData(db, 'gone-main');
    seedChildData(db, 'alive-main');

    fs.rmSync(gone, { recursive: true, force: true });
    // Current scan reports only the alive repository.
    const deleted = pruneStaleRepositoryWorktrees(db, [
      repoWorktree(alive, 'alive-main', 'main'),
    ]);

    expect(deleted).toEqual(['gone-main']);
    expect(getWorktreeById(db, 'gone-main')).toBeNull();
    expect(getWorktreeById(db, 'alive-main')).not.toBeNull();
    expect(countChildData(db, 'alive-main').chat_messages).toBe(1);
  });

  it('treats a repository present in the scan as alive even if its dir check would fail', () => {
    // A repo that produced worktrees was listed by git and is alive by
    // definition; the scan result wins over a racing filesystem read.
    const repo = makeRepoDir();
    syncWorktreesToDB(db, [repoWorktree(repo, 'r-main', 'main')]);

    fs.rmSync(repo, { recursive: true, force: true });
    const deleted = pruneStaleRepositoryWorktrees(db, [
      repoWorktree(repo, 'r-main', 'main'),
    ]);

    expect(deleted).toEqual([]);
    expect(getWorktreeById(db, 'r-main')).not.toBeNull();
  });

  it('returns an empty array when there is nothing to prune', () => {
    expect(pruneStaleRepositoryWorktrees(db, [])).toEqual([]);
  });
});
