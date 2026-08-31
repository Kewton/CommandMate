/**
 * Ghost `repositories` rows: reclamation and the line it must not cross
 * (Issue #2165).
 *
 * A repository row whose directory has been deleted stays `enabled = 1`
 * forever. Nothing removes it, so every boot and every sync re-derives the scan
 * set from it and spawns a shell into a `cwd` that no longer exists — reported
 * by Node as `spawn /bin/sh ENOENT`, an error about the shell rather than about
 * the missing directory, and logged at ERROR. Rows registered under `/tmp` were
 * still doing this seven months later.
 *
 * `pruneStaleRepositoryWorktrees` (#1349) cannot reach them. It deletes
 * *worktree* rows and iterates a `GROUP BY` over the `worktrees` table, so a
 * repository with no worktree rows is not even in its input, and its
 * `ids.length === 0` early-continue would skip it if it were.
 *
 * Most of what follows is about what reclamation must NOT touch. The chosen
 * remedy is a demotion to `enabled = 0`, not a delete, precisely because no
 * filesystem test can prove a directory is gone forever — so the tests below
 * pin both halves: the line is drawn where it is, and being wrong about it
 * costs the user nothing they cannot click back.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, createMessage, getMessages, getWorktrees } from '@/lib/db';
import {
  createRepository,
  getRepositoryById,
  getRepositoryByPath,
  getAllRepositories,
  setRepositoryEnabled,
  updateRepository,
  filterExcludedPaths,
} from '@/lib/db/db-repository';
import {
  directoryIsConfirmedAbsent,
  reclaimGhostRepositories,
  repositoryExistsOnDisk,
} from '@/lib/git/worktrees';
import type { Worktree } from '@/types/models';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

let testDb: Database.Database;
let sandbox: string;

/** Create a directory under the sandbox and give it a `.git` entry. */
function makeRepoDir(name: string): string {
  const dir = path.join(sandbox, name);
  fs.mkdirSync(path.join(dir, '.git'), { recursive: true });
  return dir;
}

/** A path under the sandbox that has never existed. */
function missingPath(name: string): string {
  return path.join(sandbox, name);
}

function worktree(id: string, repoPath: string, dirName: string): Worktree {
  return {
    id,
    name: dirName,
    branch: dirName,
    path: path.join(repoPath, dirName),
    repositoryPath: repoPath,
    repositoryName: path.basename(repoPath),
  };
}

beforeEach(() => {
  testDb = new Database(':memory:');
  runMigrations(testDb);
  sandbox = makeTempDir('ghost-repo-2165-');
});

afterEach(() => {
  testDb.close();
  removeTempDir(sandbox);
});

// ============================================================================
// The absence test itself — the "temporarily invisible" line lives here
// ============================================================================

describe('directoryIsConfirmedAbsent (Issue #2165)', () => {
  it('answers false for a directory that is there', () => {
    expect(directoryIsConfirmedAbsent(makeRepoDir('present'))).toBe(false);
  });

  it('answers true for a path that does not exist (ENOENT)', () => {
    expect(directoryIsConfirmedAbsent(missingPath('gone'))).toBe(true);
  });

  it('answers true when an ancestor is a file, so no such entry can exist (ENOTDIR)', () => {
    const file = path.join(sandbox, 'a-file');
    fs.writeFileSync(file, 'not a directory');

    expect(directoryIsConfirmedAbsent(path.join(file, 'repo'))).toBe(true);
  });

  it('answers false for a dangling symlink — the entry is real and the user owns it', () => {
    const link = path.join(sandbox, 'dangling');
    fs.symlinkSync(missingPath('nowhere'), link);

    expect(directoryIsConfirmedAbsent(link)).toBe(false);
  });

  it('answers false for an empty path', () => {
    expect(directoryIsConfirmedAbsent('')).toBe(false);
  });

  /**
   * The distinction the whole safety argument rests on. `fs.existsSync()` is
   * `accessSync(F_OK)` underneath and collapses "not there" and "could not find
   * out" into the same `false`, which is why it cannot be the reclamation test:
   * a repository behind an unreadable or unreachable mount would read as gone.
   */
  it('answers false when the lookup fails for a reason other than absence, while existsSync says gone', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits below

    const locked = path.join(sandbox, 'locked');
    fs.mkdirSync(path.join(locked, 'repo'), { recursive: true });
    fs.chmodSync(locked, 0o000);

    try {
      const hidden = path.join(locked, 'repo');

      // What the naive test would have concluded...
      expect(fs.existsSync(hidden)).toBe(false);
      expect(repositoryExistsOnDisk(hidden)).toBe(false);
      // ...and what this one concludes instead.
      expect(directoryIsConfirmedAbsent(hidden)).toBe(false);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});

// ============================================================================
// Reclamation: the row that started the Issue
// ============================================================================

describe('reclaimGhostRepositories reclaims a ghost row (Issue #2165)', () => {
  it('demotes an enabled row whose directory is gone and that owns no worktree', () => {
    const gonePath = missingPath('tmp-repos/my-flask_app');
    const repo = createRepository(testDb, {
      name: 'my-flask_app',
      path: gonePath,
      cloneSource: 'local',
    });

    const reclaimed = reclaimGhostRepositories(testDb, []);

    expect(reclaimed).toEqual([{ id: repo.id, path: gonePath }]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(false);
  });

  it('takes the reclaimed path out of the set a scan would be built from', () => {
    // The actual point: `allPaths` at startup is WORKTREE_REPOS plus every
    // ENABLED repository row, so demotion is what stops the spawn.
    const gonePath = missingPath('gone');
    const livePath = makeRepoDir('live');
    createRepository(testDb, { name: 'gone', path: gonePath, cloneSource: 'local' });
    createRepository(testDb, { name: 'live', path: livePath, cloneSource: 'local' });

    reclaimGhostRepositories(testDb, []);

    const enabledPaths = getAllRepositories(testDb)
      .filter(r => r.enabled)
      .map(r => r.path);
    expect(enabledPaths).toEqual([livePath]);
    // And the exclusion filter agrees, for the env-listed half of the set.
    expect(filterExcludedPaths(testDb, [gonePath, livePath])).toEqual([livePath]);
  });

  it('deletes nothing — the row keeps its identity, name, visibility and clone URL', () => {
    const gonePath = missingPath('cloned-then-deleted');
    const repo = createRepository(testDb, {
      name: 'cloned-then-deleted',
      path: gonePath,
      cloneSource: 'https',
      cloneUrl: 'https://example.test/org/repo.git',
      normalizedCloneUrl: 'example.test/org/repo',
    });
    updateRepository(testDb, repo.id, { displayName: 'My Clone' });

    reclaimGhostRepositories(testDb, []);

    const after = getRepositoryById(testDb, repo.id);
    expect(after).not.toBeNull();
    expect(after).toMatchObject({
      id: repo.id,
      path: gonePath,
      displayName: 'My Clone',
      visible: true,
      enabled: false,
      cloneUrl: 'https://example.test/org/repo.git',
    });
  });

  it('is idempotent — a second pass finds nothing left to do', () => {
    createRepository(testDb, {
      name: 'gone',
      path: missingPath('gone'),
      cloneSource: 'local',
    });

    expect(reclaimGhostRepositories(testDb, [])).toHaveLength(1);
    expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
  });

  it('reclaims every ghost in one pass and leaves the healthy rows enabled', () => {
    const ghosts = ['ghost-a', 'ghost-b', 'ghost-c'].map(missingPath);
    const live = makeRepoDir('live');
    for (const p of ghosts) {
      createRepository(testDb, { name: path.basename(p), path: p, cloneSource: 'local' });
    }
    createRepository(testDb, { name: 'live', path: live, cloneSource: 'local' });

    const reclaimed = reclaimGhostRepositories(testDb, []);

    expect(reclaimed.map(r => r.path).sort()).toEqual([...ghosts].sort());
    expect(getRepositoryByPath(testDb, live)!.enabled).toBe(true);
  });
});

// ============================================================================
// The line: every guard, and every guard failing toward keeping the row
// ============================================================================

describe('reclaimGhostRepositories leaves everything else alone (Issue #2165)', () => {
  it('does not touch a row whose directory is still there', () => {
    const livePath = makeRepoDir('live');
    const repo = createRepository(testDb, {
      name: 'live',
      path: livePath,
      cloneSource: 'local',
    });

    expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('does not touch a row that is present but no longer a git repository', () => {
    // `repositoryExistsOnDisk` calls this one gone (no `.git`); reclamation
    // must not, because the directory itself is right there.
    const dir = path.join(sandbox, 'de-gitified');
    fs.mkdirSync(dir, { recursive: true });
    const repo = createRepository(testDb, {
      name: 'de-gitified',
      path: dir,
      cloneSource: 'local',
    });

    expect(repositoryExistsOnDisk(dir)).toBe(false);
    expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  /**
   * The history guard, and the one the acceptance criteria single out. Chat
   * history, memos, todos, timers, schedules, tasks and verification runs all
   * hang off `worktrees`, so "zero worktree rows" is what makes reclamation
   * provably lossless — and #1666 settled that exclusion must never destroy
   * history.
   */
  it('does not touch a row that still owns worktrees, even with its directory gone', () => {
    const gonePath = missingPath('gone-but-remembered');
    const repo = createRepository(testDb, {
      name: 'gone-but-remembered',
      path: gonePath,
      cloneSource: 'local',
    });
    upsertWorktree(testDb, worktree('wt-remembered', gonePath, 'main'));
    createMessage(testDb, {
      worktreeId: 'wt-remembered',
      role: 'user',
      content: 'said before the directory went away',
      timestamp: new Date(1_700_000_000_000),
      messageType: 'normal',
    });

    expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
    expect(getWorktrees(testDb, gonePath)).toHaveLength(1);
    expect(getMessages(testDb, 'wt-remembered')).toHaveLength(1);
  });

  it('does not touch a row the environment still declares (WORKTREE_REPOS)', () => {
    // Mirrors migration v43's guard 2 (#1339): never overrule a path the env
    // still asks for. It is re-registered on every boot anyway.
    const gonePath = missingPath('env-listed');
    const repo = createRepository(testDb, {
      name: 'env-listed',
      path: gonePath,
      cloneSource: 'local',
      isEnvManaged: true,
    });

    expect(reclaimGhostRepositories(testDb, [gonePath])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('matches the env declaration after resolving it, not by raw string', () => {
    const gonePath = missingPath('env-listed');
    const repo = createRepository(testDb, {
      name: 'env-listed',
      path: gonePath,
      cloneSource: 'local',
    });

    const unresolved = path.join(sandbox, 'sub', '..', 'env-listed');
    expect(reclaimGhostRepositories(testDb, [unresolved])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
  });

  it('does not rewrite a row that is already disabled', () => {
    // #1666: `enabled = 0` is where the app stops. A disabled row is out of the
    // scan set already; there is nothing to reclaim and nothing to say about it.
    const gonePath = missingPath('already-off');
    const repo = createRepository(testDb, {
      name: 'already-off',
      path: gonePath,
      cloneSource: 'local',
    });
    setRepositoryEnabled(testDb, repo.id, false);

    expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
    expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(false);
  });

  /**
   * "Temporarily invisible" — the case the acceptance criteria name. An
   * external disk or a network volume that cannot be read answers with a
   * permission or I/O error, not with "no such file", and the row is kept.
   */
  it('does not touch a row it merely failed to look at (unreadable parent)', () => {
    if (process.getuid?.() === 0) return; // root ignores the mode bits below

    const locked = path.join(sandbox, 'locked-volume');
    const hidden = path.join(locked, 'repo');
    fs.mkdirSync(hidden, { recursive: true });
    const repo = createRepository(testDb, {
      name: 'repo',
      path: hidden,
      cloneSource: 'local',
    });
    fs.chmodSync(locked, 0o000);

    try {
      expect(reclaimGhostRepositories(testDb, [])).toEqual([]);
      expect(getRepositoryById(testDb, repo.id)!.enabled).toBe(true);
    } finally {
      fs.chmodSync(locked, 0o700);
    }
  });
});
