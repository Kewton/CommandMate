/**
 * Non-destructive repository disable — DB + scan-side behaviour (Issue #1658).
 *
 * The Repositories screen gained a Scan toggle that flips `enabled`. Before it,
 * the only way to reach `enabled = 0` was `DELETE /api/repositories`, which is
 * exclude **and purge**: it kills the tmux sessions under the repository and
 * deletes its worktree rows together with chat history, memos, todos, timers,
 * schedules, execution logs, tasks and verification runs. These tests pin the
 * two halves of the new operation:
 *
 *   1. the write side deletes nothing (`setRepositoryEnabled`);
 *   2. the read side actually honours the flag, and no prune path deletes the
 *      disabled repository's rows behind the user's back.
 *
 * (2) is the point of the Issue: a UI that sets a flag nothing reads would be
 * the same bug in a new place.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktrees, createMessage, getMessages } from '@/lib/db';
import { createVerificationRun } from '@/lib/db/verification-db';
import {
  createRepository,
  getRepositoryById,
  getRepositoryByPath,
  setRepositoryEnabled,
  countDisabledRepositories,
  registerAndFilterRepositories,
  filterExcludedPaths,
  getExcludedRepositories,
  RepositoryDbError,
  MAX_DISABLED_REPOSITORIES,
} from '@/lib/db/db-repository';
import {
  syncWorktreesToDB,
  pruneStaleRepositoryWorktrees,
} from '@/lib/git/worktrees';
import type { Worktree } from '@/types/models';
import { removeTempDir } from '@tests/helpers/temp-dir';

let testDb: Database.Database;
const tempDirs: string[] = [];

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
});

afterEach(() => {
  testDb.close();
  for (const dir of tempDirs.splice(0)) {
    removeTempDir(dir);
  }
});

/** A directory that looks like a git repository to `repositoryExistsOnDisk`. */
function makeRepoDir(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cm-1658-${name}-`));
  tempDirs.push(dir);
  fs.writeFileSync(path.join(dir, '.git'), 'gitdir: /dev/null\n');
  return dir;
}

function worktree(id: string, repoPath: string, dirName: string): Worktree {
  return {
    id,
    name: 'main',
    branch: 'main',
    path: path.join(repoPath, dirName),
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
  };
}

/**
 * Seed one worktree with a row in every child table the purging DELETE wipes
 * and that the acceptance criteria name explicitly.
 */
function seedWorktreeWithHistory(repoPath: string, worktreeId: string): void {
  upsertWorktree(testDb, worktree(worktreeId, repoPath, 'main'));

  createMessage(testDb, {
    worktreeId,
    role: 'user',
    content: 'hello from before the disable',
    timestamp: new Date(1_700_000_000_000),
    messageType: 'normal',
  });

  testDb
    .prepare(
      `INSERT INTO tasks (
         id, worktree_id, cli_tool_id, instance_id, title, goal, contract_path,
         contract_json, status, last_verification_run_id, created_at, updated_at,
         started_at, finished_at
       ) VALUES (?, ?, 'claude', NULL, 'task title', 'task goal', NULL, '{}', 'pending', NULL, ?, ?, NULL, NULL)`
    )
    .run(`task-${worktreeId}`, worktreeId, 1_700_000_000_000, 1_700_000_000_000);

  createVerificationRun(testDb, { worktreeId, trigger: 'manual' });
}

function countRows(table: string, worktreeId: string): number {
  const row = testDb
    .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE worktree_id = ?`)
    .get(worktreeId) as { count: number };
  return Number(row.count) || 0;
}

// ============================================================
// setRepositoryEnabled()
// ============================================================

describe('setRepositoryEnabled (Issue #1658)', () => {
  it('flips enabled to false and leaves visible and displayName alone', () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      enabled: true,
      visible: true,
    });
    // displayName is set through the generic updater, like the alias edit does.
    const withAlias = { ...repo, displayName: 'Repo A' };
    testDb
      .prepare('UPDATE repositories SET display_name = ? WHERE id = ?')
      .run(withAlias.displayName, repo.id);

    const updated = setRepositoryEnabled(testDb, repo.id, false);

    expect(updated?.enabled).toBe(false);
    // Concept independence (Issue #690): enabled and visible are orthogonal.
    expect(updated?.visible).toBe(true);
    expect(updated?.displayName).toBe('Repo A');

    const reread = getRepositoryById(testDb, repo.id)!;
    expect(reread.enabled).toBe(false);
    expect(reread.visible).toBe(true);
  });

  it('flips enabled back to true', () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      enabled: false,
    });

    const updated = setRepositoryEnabled(testDb, repo.id, true);

    expect(updated?.enabled).toBe(true);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('does not resurrect a hidden repository when it is re-enabled', () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      enabled: true,
      visible: false,
    });

    setRepositoryEnabled(testDb, repo.id, false);
    setRepositoryEnabled(testDb, repo.id, true);

    // The user's own visibility choice survives the round trip.
    expect(getRepositoryById(testDb, repo.id)!.visible).toBe(false);
  });

  it('returns null for an unknown repository id', () => {
    expect(setRepositoryEnabled(testDb, 'does-not-exist', false)).toBeNull();
  });

  it('is a no-op when the repository is already in the requested state', () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
      enabled: false,
    });
    const before = getRepositoryById(testDb, repo.id)!;

    const result = setRepositoryEnabled(testDb, repo.id, false);

    expect(result?.enabled).toBe(false);
    expect(getRepositoryById(testDb, repo.id)!.updatedAt.getTime()).toBe(
      before.updatedAt.getTime()
    );
  });
});

// ============================================================
// SEC-SF-004 ceiling
// ============================================================

describe('MAX_DISABLED_REPOSITORIES ceiling (SEC-SF-004)', () => {
  /** Fill the disabled table straight through SQL — 1000 createRepository
   *  round trips are not what this test is about. */
  function seedDisabledRows(count: number): void {
    const insert = testDb.prepare(`
      INSERT INTO repositories (
        id, name, path, enabled, visible, clone_url, normalized_clone_url,
        clone_source, is_env_managed, created_at, updated_at
      ) VALUES (?, ?, ?, 0, 1, NULL, NULL, 'local', 0, 0, 0)
    `);
    const many = testDb.transaction((n: number) => {
      for (let i = 0; i < n; i++) {
        insert.run(`filler-${i}`, `filler-${i}`, `/repos/filler-${i}`);
      }
    });
    many(count);
  }

  it('counts only disabled rows', () => {
    createRepository(testDb, { name: 'on', path: '/repos/on', cloneSource: 'local' });
    seedDisabledRows(3);

    expect(countDisabledRepositories(testDb)).toBe(3);
  });

  it('refuses to disable one more once the ceiling is reached', () => {
    seedDisabledRows(MAX_DISABLED_REPOSITORIES);
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    expect(() => setRepositoryEnabled(testDb, repo.id, false)).toThrow(RepositoryDbError);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('reports LIMIT_EXCEEDED so the route can answer 409', () => {
    seedDisabledRows(MAX_DISABLED_REPOSITORIES);
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    try {
      setRepositoryEnabled(testDb, repo.id, false);
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(RepositoryDbError);
      expect((error as RepositoryDbError).code).toBe('LIMIT_EXCEEDED');
    }
  });

  it('still allows re-enabling at the ceiling, and disabling again afterwards', () => {
    seedDisabledRows(MAX_DISABLED_REPOSITORIES);
    const alreadyDisabled = getRepositoryByPath(testDb, '/repos/filler-0')!;

    // Going the other way never adds a disabled row.
    expect(setRepositoryEnabled(testDb, alreadyDisabled.id, true)?.enabled).toBe(true);
    // ...which frees exactly one slot again.
    expect(setRepositoryEnabled(testDb, alreadyDisabled.id, false)?.enabled).toBe(false);
  });
});

// ============================================================
// Acceptance criterion: nothing is deleted
// ============================================================

describe('disabling deletes nothing (Issue #1658 acceptance)', () => {
  it('keeps every worktree row and its chat history, tasks and verification runs', () => {
    const repoPath = '/repos/repo-a';
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: repoPath,
      cloneSource: 'local',
    });
    seedWorktreeWithHistory(repoPath, 'wt-a');

    expect(getWorktrees(testDb, repoPath)).toHaveLength(1);
    expect(getMessages(testDb, 'wt-a')).toHaveLength(1);
    expect(countRows('tasks', 'wt-a')).toBe(1);
    expect(countRows('verification_runs', 'wt-a')).toBe(1);

    setRepositoryEnabled(testDb, repo.id, false);

    expect(getWorktrees(testDb, repoPath)).toHaveLength(1);
    expect(getMessages(testDb, 'wt-a')).toHaveLength(1);
    expect(countRows('tasks', 'wt-a')).toBe(1);
    expect(countRows('verification_runs', 'wt-a')).toBe(1);
  });

  it('lists the disabled repository so the UI can offer it back', () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/repos/repo-a',
      cloneSource: 'local',
    });

    setRepositoryEnabled(testDb, repo.id, false);

    expect(getExcludedRepositories(testDb).map((r) => r.id)).toEqual([repo.id]);
  });
});

// ============================================================
// Acceptance criterion: the scan side honours the flag
// ============================================================

describe('a disabled repository is not scanned again (Issue #1658 acceptance)', () => {
  it('drops the disabled path from the paths a sync would scan', () => {
    const enabledPath = '/repos/keep';
    const disabledPath = '/repos/drop';
    createRepository(testDb, { name: 'keep', path: enabledPath, cloneSource: 'local' });
    const drop = createRepository(testDb, {
      name: 'drop',
      path: disabledPath,
      cloneSource: 'local',
    });

    setRepositoryEnabled(testDb, drop.id, false);

    const summary = registerAndFilterRepositories(testDb, [enabledPath, disabledPath]);

    expect(summary.filteredPaths).toEqual([enabledPath]);
    expect(summary.excludedPaths).toEqual([disabledPath]);
    // And the lower-level filter agrees, including for a non-canonical spelling.
    expect(filterExcludedPaths(testDb, [`${disabledPath}/`])).toEqual([]);
  });

  it('does not re-enable the repository just because the path is registered again', () => {
    const disabledPath = '/repos/drop';
    const drop = createRepository(testDb, {
      name: 'drop',
      path: disabledPath,
      cloneSource: 'local',
    });
    setRepositoryEnabled(testDb, drop.id, false);

    // A sync run registers env paths before filtering; registration must not
    // undo the exclusion (this is what made #190's bug come back).
    registerAndFilterRepositories(testDb, [disabledPath]);

    expect(getRepositoryById(testDb, drop.id)!.enabled).toBe(false);
  });
});

// ============================================================
// Acceptance criterion: disabling must not trigger a prune
// ============================================================

describe('disabling does not let a prune reach the rows (Issue #1658 acceptance)', () => {
  it('leaves the disabled repository untouched when the next sync scans only the others', () => {
    const keepDir = makeRepoDir('keep');
    const dropDir = makeRepoDir('drop');
    createRepository(testDb, { name: 'keep', path: keepDir, cloneSource: 'local' });
    const drop = createRepository(testDb, { name: 'drop', path: dropDir, cloneSource: 'local' });

    upsertWorktree(testDb, worktree('wt-keep', keepDir, 'main'));
    seedWorktreeWithHistory(dropDir, 'wt-drop');

    setRepositoryEnabled(testDb, drop.id, false);

    // The sync scans only the still-enabled repository, so the disabled one
    // contributes no worktrees at all.
    const scanned = [worktree('wt-keep', keepDir, 'main')];
    const syncResult = syncWorktreesToDB(testDb, scanned);
    const prunedIds = pruneStaleRepositoryWorktrees(testDb, scanned);

    expect(syncResult.deletedIds).toEqual([]);
    expect(prunedIds).toEqual([]);
    expect(getWorktrees(testDb, dropDir)).toHaveLength(1);
    expect(getMessages(testDb, 'wt-drop')).toHaveLength(1);
    expect(countRows('tasks', 'wt-drop')).toBe(1);
    expect(countRows('verification_runs', 'wt-drop')).toBe(1);
  });

  it('survives the two-scan-roots-one-git-repo case that started this (#1659)', () => {
    // Both directories are registered scan roots of the SAME git repository, so
    // `git worktree list` returns the identical path set from either one. The
    // user disables one of them; the other keeps reporting both paths.
    const rootA = makeRepoDir('root-a');
    const rootB = makeRepoDir('root-b');
    const repoA = createRepository(testDb, { name: 'root-a', path: rootA, cloneSource: 'local' });
    createRepository(testDb, { name: 'root-b', path: rootB, cloneSource: 'local' });

    seedWorktreeWithHistory(rootA, 'wt-shared');

    setRepositoryEnabled(testDb, repoA.id, false);

    // Scan of root B alone still sees root A's directory as one of its worktrees.
    const scanned: Worktree[] = [
      { ...worktree('wt-shared', rootA, 'main'), repositoryPath: rootB, repositoryName: path.basename(rootB) },
      worktree('wt-b-main', rootB, 'main'),
    ];
    const syncResult = syncWorktreesToDB(testDb, scanned);
    const prunedIds = pruneStaleRepositoryWorktrees(testDb, scanned);

    expect(syncResult.deletedIds).toEqual([]);
    expect(prunedIds).toEqual([]);
    // The row moved scan roots but kept its identity and its history.
    expect(getMessages(testDb, 'wt-shared')).toHaveLength(1);
    expect(countRows('tasks', 'wt-shared')).toBe(1);
    expect(countRows('verification_runs', 'wt-shared')).toBe(1);
  });

  it('still prunes a repository whose directory is genuinely gone', () => {
    // The guard above must not have turned pruneStaleRepositoryWorktrees into a
    // no-op: a vanished repository is still cleaned up (Issue #1349).
    const goneDir = makeRepoDir('gone');
    createRepository(testDb, { name: 'gone', path: goneDir, cloneSource: 'local' });
    upsertWorktree(testDb, worktree('wt-gone', goneDir, 'main'));
    removeTempDir(goneDir);

    const prunedIds = pruneStaleRepositoryWorktrees(testDb, []);

    expect(prunedIds).toEqual(['wt-gone']);
  });
});
