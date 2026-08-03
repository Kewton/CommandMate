/**
 * Issue #1658: two scan roots on ONE git repository made worktree IDs grow by 8
 * hex digits on every sync.
 *
 * `CommandAgent` and `CommandAgent-develop` are two worktrees of the same
 * repository, and both were registered in `WORKTREE_REPOS`. `git worktree list`
 * returns the identical five paths from either one, so a single sync visits
 * every path twice — once per `repositoryPath` group.
 *
 * `syncWorktreesToDB` resolved "which ID does this path already own?" through
 * `getWorktreesByRepository`, i.e. scoped by `worktrees.repository_path`. But
 * identity is `worktrees.path` (`NOT NULL UNIQUE`); `repository_path` only
 * records which scan root upserted the row last, and with two scan roots it
 * ping-pongs. The lookup therefore came up empty on whichever pass did not write
 * it last, the ID was re-derived against a taken set holding the row's own ID
 * and its own aliases, and `deriveWorktreeId` answered one rung further up the
 * digest ladder. Production reached 81 characters; the tmux session name derived
 * from the ID stopped matching the running session and the UI lost it.
 *
 * The regression test is the first one below: three syncs, not one character of
 * movement. It fails (IDs grow) if the path lookup is scoped per repository
 * again — verified by mutation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  syncWorktreesToDB,
  deriveIdIgnoringOwnHistory,
  type ScannedWorktree,
} from '@/lib/git/worktrees';
import { deriveWorktreeId } from '@/lib/git/worktree-id';
import { getWorktreeById, recordWorktreeAlias, resolveWorktreeIdWithAlias } from '@/lib/db';

/** The two scan roots — a repository and one of its own linked worktrees. */
const REPO_A = '/repos/CommandAgent';
const REPO_B = '/repos/CommandAgent-develop';

/** What `git worktree list` returns from EITHER root: the same five paths. */
const SHARED_PATHS = [
  '/repos/CommandAgent',
  '/private/tmp/commandagent-bon0-run',
  '/private/tmp/commandagent-f-bon-v-run',
  '/private/tmp/commandagent-ingest-luna-run',
  '/repos/CommandAgent-develop',
];

/**
 * One repository's scan result. `id` is the provisional suggestion
 * `scanWorktrees` attaches (basename-derived, collision-blind).
 */
function scanOf(repositoryPath: string, paths: string[] = SHARED_PATHS): ScannedWorktree[] {
  return paths.map((worktreePath) => ({
    id: deriveWorktreeId(path.resolve(worktreePath)),
    name: 'main',
    branch: 'main',
    path: path.resolve(worktreePath),
    repositoryPath,
    repositoryName: path.basename(repositoryPath),
  }));
}

/** The full scan a global sync hands over: both roots, concatenated. */
function bothRoots(): ScannedWorktree[] {
  return [...scanOf(REPO_A), ...scanOf(REPO_B)];
}

function idsByPath(db: Database.Database): Record<string, string> {
  const rows = db.prepare('SELECT id, path FROM worktrees').all() as Array<{
    id: string;
    path: string;
  }>;
  return Object.fromEntries(rows.map((row) => [row.path, row.id]));
}

function aliasIds(db: Database.Database): string[] {
  return (
    db.prepare('SELECT old_id FROM worktree_aliases ORDER BY old_id').all() as Array<{
      old_id: string;
    }>
  ).map((row) => row.old_id);
}

describe('Issue #1658: one repository behind two scan roots', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('keeps every ID byte-identical across three consecutive syncs', () => {
    syncWorktreesToDB(db, bothRoots());
    const first = idsByPath(db);

    // Every path got the plain basename: the second group must not have
    // re-minted what the first group just assigned, not even on the very first
    // sync (there is no row to look up yet when the second group runs).
    expect(first).toEqual({
      '/repos/CommandAgent': 'commandagent',
      '/private/tmp/commandagent-bon0-run': 'commandagent-bon0-run',
      '/private/tmp/commandagent-f-bon-v-run': 'commandagent-f-bon-v-run',
      '/private/tmp/commandagent-ingest-luna-run': 'commandagent-ingest-luna-run',
      '/repos/CommandAgent-develop': 'commandagent-develop',
    });

    syncWorktreesToDB(db, bothRoots());
    expect(idsByPath(db)).toEqual(first);

    syncWorktreesToDB(db, bothRoots());
    expect(idsByPath(db)).toEqual(first);

    // Nothing was renamed, so nothing was retired: the alias ladder that grew in
    // production (`…-2f4530fe`, `…-2f4530fe1cf1f9f8`, …) never starts.
    expect(aliasIds(db)).toEqual([]);
    expect(Object.keys(idsByPath(db))).toHaveLength(SHARED_PATHS.length);
  });

  it('does not grow IDs even when the two roots are scanned in the other order', () => {
    // `repository_path` is written by whichever group runs last, so the order
    // decides which pass "loses" the lookup. Neither may move an ID.
    syncWorktreesToDB(db, [...scanOf(REPO_A), ...scanOf(REPO_B)]);
    const first = idsByPath(db);

    syncWorktreesToDB(db, [...scanOf(REPO_B), ...scanOf(REPO_A)]);
    expect(idsByPath(db)).toEqual(first);
    expect(aliasIds(db)).toEqual([]);
  });

  it('keeps IDs frozen while repository_path itself keeps ping-ponging', () => {
    // The column really does flip — this pins that the fix works *despite* it
    // rather than by accidentally freezing it (which would break prune scoping).
    syncWorktreesToDB(db, [...scanOf(REPO_A), ...scanOf(REPO_B)]);
    const repoPathOf = () =>
      (
        db.prepare('SELECT repository_path FROM worktrees WHERE id = ?').get('commandagent') as {
          repository_path: string;
        }
      ).repository_path;
    expect(repoPathOf()).toBe(REPO_B);

    syncWorktreesToDB(db, [...scanOf(REPO_B), ...scanOf(REPO_A)]);
    expect(repoPathOf()).toBe(REPO_A);
    expect(getWorktreeById(db, 'commandagent')).not.toBeNull();
  });

  it('preserves child rows across the repeated syncs', () => {
    syncWorktreesToDB(db, bothRoots());
    db.prepare(
      `INSERT INTO chat_messages (worktree_id, role, content, timestamp, cli_tool_id)
       VALUES ('commandagent-bon0-run', 'user', 'hello', ?, 'claude')`
    ).run(Date.now());

    syncWorktreesToDB(db, bothRoots());
    syncWorktreesToDB(db, bothRoots());

    const kept = db
      .prepare('SELECT COUNT(*) AS n FROM chat_messages WHERE worktree_id = ?')
      .get('commandagent-bon0-run') as { n: number };
    expect(kept.n).toBe(1);
  });

  describe('collision detection survives the global lookup', () => {
    it('still disambiguates same-basename directories in different repositories', () => {
      syncWorktreesToDB(db, [
        ...scanOf('/repos/alpha', ['/repos/alpha/main']),
        ...scanOf('/repos/beta', ['/repos/beta/main']),
      ]);

      const ids = idsByPath(db);
      expect(ids[path.resolve('/repos/alpha/main')]).toBe('main');
      expect(ids[path.resolve('/repos/beta/main')]).toMatch(/^main-[0-9a-f]{8}$/);
    });

    it('does not hand a new directory an ID that an alias still answers', () => {
      syncWorktreesToDB(db, scanOf('/repos/alpha', ['/repos/alpha/main']));
      recordWorktreeAlias(db, 'gamma', 'main');

      syncWorktreesToDB(db, [
        ...scanOf('/repos/alpha', ['/repos/alpha/main']),
        ...scanOf('/repos/gamma', ['/repos/gamma/gamma']),
      ]);

      const ids = idsByPath(db);
      expect(ids[path.resolve('/repos/gamma/gamma')]).toMatch(/^gamma-[0-9a-f]{8}$/);
      // The old bookmark still lands where it always did.
      expect(resolveWorktreeIdWithAlias(db, 'gamma')).toBe('main');
    });
  });

  describe('pruning', () => {
    it('still deletes a row whose path is gone from every scan root', () => {
      syncWorktreesToDB(db, bothRoots());
      expect(getWorktreeById(db, 'commandagent-bon0-run')).not.toBeNull();

      const survivors = SHARED_PATHS.filter(
        (p) => p !== '/private/tmp/commandagent-bon0-run'
      );
      const result = syncWorktreesToDB(db, [
        ...scanOf(REPO_A, survivors),
        ...scanOf(REPO_B, survivors),
      ]);

      expect(result.deletedIds).toEqual(['commandagent-bon0-run']);
      expect(getWorktreeById(db, 'commandagent-bon0-run')).toBeNull();
      expect(Object.keys(idsByPath(db))).toHaveLength(survivors.length);
    });

    it('never prunes another repository\'s rows', () => {
      syncWorktreesToDB(db, [
        ...scanOf('/repos/alpha', ['/repos/alpha', '/repos/alpha-feature']),
        ...scanOf('/repos/beta', ['/repos/beta']),
      ]);
      expect(Object.keys(idsByPath(db))).toHaveLength(3);

      // A scan that reports only alpha's two paths: beta is simply not part of
      // this request and must be left completely alone.
      const result = syncWorktreesToDB(
        db,
        scanOf('/repos/alpha', ['/repos/alpha', '/repos/alpha-feature'])
      );

      expect(result.deletedIds).toEqual([]);
      expect(getWorktreeById(db, 'beta')).not.toBeNull();
    });

    it('keeps a path that only the OTHER scan root still reports', () => {
      // The row's `repository_path` says B while B no longer lists it and A
      // does. Scoping liveness to one root would delete the row here — and the
      // next group would re-insert it as a brand-new worktree, with a new ID and
      // no history, which is the very failure this issue is about.
      syncWorktreesToDB(db, [...scanOf(REPO_A), ...scanOf(REPO_B)]);
      const before = idsByPath(db);

      const onlyInA = ['/private/tmp/commandagent-bon0-run'];
      const inBoth = SHARED_PATHS.filter((p) => !onlyInA.includes(p));
      const result = syncWorktreesToDB(db, [
        ...scanOf(REPO_B, inBoth),
        ...scanOf(REPO_A, SHARED_PATHS),
      ]);

      expect(result.deletedIds).toEqual([]);
      expect(idsByPath(db)).toEqual(before);
    });
  });

  describe('deriveIdIgnoringOwnHistory', () => {
    const churnedPath = path.resolve('/private/tmp/commandagent-bon0-run');

    it('re-mints the ID the path already has instead of climbing the ladder', () => {
      const current = 'commandagent-bon0-run';
      // Everything the row answers to is "taken" — by the row itself.
      const taken = new Set([current, `${current}-2f4530fe`]);

      expect(deriveWorktreeId(churnedPath, taken)).not.toBe(current);
      expect(deriveIdIgnoringOwnHistory(churnedPath, taken, taken)).toBe(current);
    });

    it('converges instead of growing when a whole ladder is in the taken set', () => {
      const base = 'commandagent-bon0-run';
      const own = new Set([base]);
      let id = base;
      // Six rounds of the production failure: each answer is fed back in.
      for (let round = 0; round < 6; round++) {
        id = deriveIdIgnoringOwnHistory(churnedPath, own, own);
        own.add(id);
      }
      expect(id).toBe(base);
      expect(own.size).toBe(1);
    });

    it('still respects IDs that belong to somebody else', () => {
      const taken = new Set(['commandagent-bon0-run']);
      const mine = new Set(['commandagent-bon0-run-deadbeef']);

      const id = deriveIdIgnoringOwnHistory(churnedPath, taken, mine);
      expect(id).not.toBe('commandagent-bon0-run');
      expect(id).toMatch(/^commandagent-bon0-run-[0-9a-f]{8}$/);
    });

    it('falls back to the plain derivation when the path has no history', () => {
      const taken = new Set(['commandagent-bon0-run']);
      expect(deriveIdIgnoringOwnHistory(churnedPath, taken, undefined)).toBe(
        deriveWorktreeId(churnedPath, taken)
      );
      expect(deriveIdIgnoringOwnHistory(churnedPath, taken, new Set())).toBe(
        deriveWorktreeId(churnedPath, taken)
      );
    });
  });
});
