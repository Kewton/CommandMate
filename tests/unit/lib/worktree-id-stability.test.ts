/**
 * Issue #1621 / #1644 Phase 1: a worktree's ID is a property of its DIRECTORY,
 * minted once and never re-derived.
 *
 * Before this change the ID was `sanitize(repoName)-sanitize(branch)`, so
 * `git checkout` in a directory silently renamed the worktree's primary key.
 * #1151 stopped that from destroying history (the row is migrated rather than
 * deleted), but everything keyed on the ID *outside* the DB — tmux session
 * names, open tabs, bookmarks, poller and Auto-Yes keys — still broke. The fix
 * is not a better derivation rule; it is not deriving a second time.
 *
 * These tests pin both halves:
 *   - `deriveWorktreeId` as a pure function (sanitize, collisions, determinism)
 *   - `syncWorktreesToDB` keeping an existing path's ID across branch switches,
 *     detached-HEAD commits and repeated syncs.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import { createHash } from 'crypto';
import Database from 'better-sqlite3';
import { getWorktreeById, getAllWorktreeIds } from '@/lib/db';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  deriveWorktreeId,
  syncWorktreesToDB,
  type ScannedWorktree,
} from '@/lib/git/worktrees';
import { isValidWorktreeId } from '@/lib/security/path-validator';

const REPO_PATH = '/repos/anvil';

/**
 * Build the object shape `scanWorktrees` produces for one worktree, including
 * its *provisional* (path-derived, collision-unaware) id. Mirroring the real
 * producer matters: a test that omitted `id` would silently exercise a code
 * path production never takes.
 */
function scanned(
  worktreePath: string,
  branch: string,
  repositoryPath: string = REPO_PATH
): ScannedWorktree {
  const resolved = path.resolve(worktreePath);
  return {
    id: deriveWorktreeId(resolved),
    name: branch,
    branch,
    path: resolved,
    repositoryPath,
    repositoryName: path.basename(repositoryPath),
  };
}

function sha8(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8);
}

describe('deriveWorktreeId', () => {
  it('uses the sanitized directory basename when nothing holds it', () => {
    expect(deriveWorktreeId('/repos/commandmate-issue-1644')).toBe(
      'commandmate-issue-1644'
    );
    // The repository name and the branch are deliberately absent from the ID.
    expect(deriveWorktreeId('/Users/me/work/MyCodeBranchDesk')).toBe(
      'mycodebranchdesk'
    );
  });

  it('sanitizes with the same alphabet the legacy scheme used', () => {
    expect(deriveWorktreeId('/repos/Feature@Foo')).toBe('feature-foo');
    expect(deriveWorktreeId('/repos/release_v1.0.0')).toBe('release-v1-0-0');
    expect(deriveWorktreeId('/repos/--weird--name--')).toBe('weird-name');
    expect(deriveWorktreeId('/repos/x/')).toBe('x');
  });

  it('always produces something isValidWorktreeId accepts', () => {
    for (const candidate of [
      '/repos/commandmate-issue-1644',
      '/repos/Feature@Foo',
      '/repos/日本語ディレクトリ',
      '/',
      '///',
    ]) {
      const id = deriveWorktreeId(candidate);
      expect(isValidWorktreeId(id), `${candidate} -> ${JSON.stringify(id)}`).toBe(
        true
      );
    }
  });

  it('falls back to a non-empty base when the basename sanitizes away', () => {
    // `basename('/')` is '' and `basename('/@@@')` sanitizes to ''. An empty ID
    // would be stored happily by SQLite and rejected by every route validator.
    expect(deriveWorktreeId('/')).toBe('worktree');
    expect(deriveWorktreeId('/@@@')).toBe('worktree');
  });

  it('appends a path digest only when the plain basename is taken', () => {
    const p = '/repos/b/main';
    expect(deriveWorktreeId(p, [])).toBe('main');
    expect(deriveWorktreeId(p, ['main'])).toBe(`main-${sha8(p)}`);
  });

  it('is idempotent: the same path and taken set always yield the same ID', () => {
    const p = '/repos/b/main';
    expect(deriveWorktreeId(p, [])).toBe(deriveWorktreeId(p, []));
    expect(deriveWorktreeId(p, ['main'])).toBe(deriveWorktreeId(p, ['main']));

    // The digest is a function of the path, not of a counter, so re-deriving
    // never walks to a different suffix.
    const first = deriveWorktreeId(p, ['main']);
    const second = deriveWorktreeId(p, ['main']);
    const third = deriveWorktreeId(p, new Set(['main']));
    expect(new Set([first, second, third]).size).toBe(1);
  });

  it('separates two different paths that share a basename', () => {
    const a = '/repos/a/main';
    const b = '/repos/b/main';
    const idA = deriveWorktreeId(a, []);
    const idB = deriveWorktreeId(b, [idA]);
    expect(idA).toBe('main');
    expect(idB).toBe(`main-${sha8(b)}`);
    expect(idA).not.toBe(idB);
  });

  it('lengthens the digest when even the 8-char suffix is taken', () => {
    const p = '/repos/b/main';
    const digest = createHash('sha256').update(p).digest('hex');
    expect(deriveWorktreeId(p, ['main', `main-${digest.slice(0, 8)}`])).toBe(
      `main-${digest.slice(0, 16)}`
    );
  });

  it('accepts a Set as well as an array', () => {
    expect(deriveWorktreeId('/repos/b/main', new Set(['main']))).toBe(
      `main-${sha8('/repos/b/main')}`
    );
  });
});

describe('syncWorktreesToDB: the ID follows the directory, not the branch', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('mints a path-derived ID for a worktree it has never seen', () => {
    syncWorktreesToDB(db, [scanned('/repos/anvil', 'develop')]);

    expect(getAllWorktreeIds(db)).toEqual(['anvil']);
    const wt = getWorktreeById(db, 'anvil');
    expect(wt?.path).toBe('/repos/anvil');
    expect(wt?.branch).toBe('develop');
    // `name` is the display branch name (Issue #1621).
    expect(wt?.name).toBe('develop');
  });

  it('keeps the ID when the branch changes in the same directory', () => {
    syncWorktreesToDB(db, [scanned('/repos/anvil', 'develop')]);
    const before = getAllWorktreeIds(db);

    // `git checkout feature/x` then a sync (server restart / sidebar sync).
    syncWorktreesToDB(db, [scanned('/repos/anvil', 'feature/x')]);

    expect(getAllWorktreeIds(db)).toEqual(before);
    const wt = getWorktreeById(db, 'anvil');
    // Only the display attributes moved.
    expect(wt?.branch).toBe('feature/x');
    expect(wt?.name).toBe('feature/x');
  });

  it('refreshes the display name from the real branch on every sync', () => {
    // `name` and `branch` are deliberately different here. A scan always sets
    // them to the same string, so an assertion that only compared them against
    // each other would pass even if sync stopped refreshing `name` at all.
    syncWorktreesToDB(db, [
      { ...scanned('/repos/anvil', 'develop'), name: 'stale-label' },
    ]);
    expect(getWorktreeById(db, 'anvil')?.name).toBe('develop');

    syncWorktreesToDB(db, [
      { ...scanned('/repos/anvil', 'feature/x'), name: 'another-stale-label' },
    ]);
    expect(getWorktreeById(db, 'anvil')?.name).toBe('feature/x');
  });

  it('keeps the ID across a long branch-switch sequence', () => {
    const branches = ['develop', 'feature/a', 'main', 'fix/b', 'develop'];
    for (const branch of branches) {
      syncWorktreesToDB(db, [scanned('/repos/anvil', branch)]);
      expect(getAllWorktreeIds(db)).toEqual(['anvil']);
    }
    expect(getWorktreeById(db, 'anvil')?.branch).toBe('develop');
  });

  it('keeps the ID when a detached HEAD advances commit by commit', () => {
    // `git worktree list` reports a detached worktree as `(detached HEAD)`, and
    // parseWorktreeOutput turns that into the pseudo-branch `detached-<sha>`.
    // Under the old scheme that made the ID change on EVERY commit.
    syncWorktreesToDB(db, [scanned('/repos/anvil', 'detached-e4f00e91')]);
    const afterFirst = getAllWorktreeIds(db);

    syncWorktreesToDB(db, [scanned('/repos/anvil', 'detached-9ab12cd3')]);
    syncWorktreesToDB(db, [scanned('/repos/anvil', 'detached-771f0a55')]);

    expect(getAllWorktreeIds(db)).toEqual(afterFirst);
    expect(getAllWorktreeIds(db)).toEqual(['anvil']);
    expect(getWorktreeById(db, 'anvil')?.name).toBe('detached-771f0a55');
  });

  it('is idempotent: re-syncing the same scan changes nothing', () => {
    const scan = [
      scanned('/repos/anvil', 'develop'),
      scanned('/repos/anvil-feature-1', 'feature/1'),
    ];
    syncWorktreesToDB(db, scan);
    const first = getAllWorktreeIds(db).sort();

    syncWorktreesToDB(db, scan);
    syncWorktreesToDB(db, scan);

    expect(getAllWorktreeIds(db).sort()).toEqual(first);
    expect(first).toEqual(['anvil', 'anvil-feature-1']);
  });

  it('disambiguates same-named directories in different repositories', () => {
    // Both repositories hold a `main` directory. IDs are a global primary key,
    // so the second must not claim `main` — and must not steal the first row's
    // path either (UNIQUE(path) would throw).
    syncWorktreesToDB(db, [
      scanned('/repos/a/main', 'main', '/repos/a'),
      scanned('/repos/b/main', 'main', '/repos/b'),
    ]);

    const ids = getAllWorktreeIds(db).sort();
    expect(ids).toHaveLength(2);
    expect(ids).toContain('main');
    const other = ids.find((id) => id !== 'main')!;
    expect(other).toMatch(/^main-[0-9a-f]{8}$/);

    // Both rows survive, on their own paths.
    const paths = ids.map((id) => getWorktreeById(db, id)?.path).sort();
    expect(paths).toEqual(['/repos/a/main', '/repos/b/main']);
  });

  it('does not hand a new worktree an ID that a live worktree already holds', () => {
    syncWorktreesToDB(db, [scanned('/repos/a/main', 'main', '/repos/a')]);
    // A second repository is registered later, in its own sync run.
    syncWorktreesToDB(db, [scanned('/repos/b/main', 'main', '/repos/b')]);

    expect(getAllWorktreeIds(db)).toHaveLength(2);
    expect(getWorktreeById(db, 'main')?.path).toBe('/repos/a/main');
  });

  it('honours a caller-supplied ID only while it is free', () => {
    // Legacy/explicit callers (non-scan writers) still get their ID...
    syncWorktreesToDB(db, [
      { ...scanned('/repos/anvil', 'develop'), id: 'legacy-explicit-id' },
    ]);
    expect(getAllWorktreeIds(db)).toEqual(['legacy-explicit-id']);

    // ...but never at the cost of the ID a path already owns.
    syncWorktreesToDB(db, [
      { ...scanned('/repos/anvil', 'develop'), id: 'some-other-id' },
    ]);
    expect(getAllWorktreeIds(db)).toEqual(['legacy-explicit-id']);
  });

  it('frees the ID of a worktree that is genuinely removed from disk', () => {
    syncWorktreesToDB(db, [
      scanned('/repos/anvil', 'develop'),
      scanned('/repos/anvil-tmp', 'feature/tmp'),
    ]);
    expect(getAllWorktreeIds(db).sort()).toEqual(['anvil', 'anvil-tmp']);

    // `git worktree remove` drops the directory; the next scan omits it.
    const result = syncWorktreesToDB(db, [scanned('/repos/anvil', 'develop')]);
    expect(result.deletedIds).toEqual(['anvil-tmp']);

    // A brand-new worktree can now take the freed name without a digest suffix.
    syncWorktreesToDB(db, [
      scanned('/repos/anvil', 'develop'),
      scanned('/repos/anvil-tmp', 'feature/other'),
    ]);
    expect(getAllWorktreeIds(db).sort()).toEqual(['anvil', 'anvil-tmp']);
  });
});
