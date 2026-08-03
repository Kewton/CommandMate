/**
 * Historical worktree IDs and the worktree they now resolve to (Issue #1621,
 * Phase 2; table created by migration v53).
 *
 * A worktree ID leaks out of the database the moment it is minted: into URLs
 * the user bookmarks, into tabs they leave open, into `commandmate send <id>`
 * lines in someone's script. #1644 stops the ID from moving on its own, but IDs
 * written under the old branch-derived scheme still have to be renumbered
 * (#1645), and a directory can still be moved. Recording the old ID is what
 * keeps every one of those references answering instead of 404ing.
 *
 * Deliberately free of any dependency on the request/singleton layer: every
 * function takes the `db` it should act on. The route-boundary wrapper that
 * reaches for the singleton lives in `@/lib/git/git-route-worktree`.
 */

import type Database from 'better-sqlite3';

/** One historical ID and the worktree it resolves to today. */
export interface WorktreeAlias {
  oldId: string;
  worktreeId: string;
  createdAt: number;
}

/**
 * Whether `worktree_aliases` exists in this database.
 *
 * A database opened by `getDbInstance` is always migrated, but tests hand
 * hand-built connections around and the CLI can point at an older file. Callers
 * on the request path must degrade to "no alias" rather than throw, so the
 * lookups below check first.
 */
function hasAliasTable(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_aliases'"
    )
    .get();
  return row !== undefined;
}

/**
 * Record that `oldId` used to name the worktree now known as `worktreeId`.
 *
 * Idempotent, and safe to call from inside the rename transaction:
 *
 * - a self-alias (`oldId === worktreeId`) is dropped — it would resolve to
 *   itself and shadow nothing useful;
 * - an alias whose `old_id` equals the *destination* is deleted, because that
 *   ID is a live worktree again and the live row must win;
 * - re-recording an existing `old_id` re-points it (`ON CONFLICT DO UPDATE`),
 *   so an ID renamed A→B→C resolves A→C in one hop rather than a chain.
 *
 * @param db - Database instance (caller supplies the transaction, if any)
 * @param oldId - The ID that is being retired
 * @param worktreeId - The ID it should resolve to from now on
 * @param now - Timestamp in epoch milliseconds
 */
export function recordWorktreeAlias(
  db: Database.Database,
  oldId: string,
  worktreeId: string,
  now: number = Date.now()
): void {
  if (!oldId || !worktreeId || oldId === worktreeId) return;
  if (!hasAliasTable(db)) return;

  // The destination ID now names a live worktree; any alias claiming it as a
  // historical name is stale and would only confuse resolution.
  db.prepare('DELETE FROM worktree_aliases WHERE old_id = ?').run(worktreeId);

  db.prepare(
    `INSERT INTO worktree_aliases (old_id, worktree_id, created_at)
     VALUES (?, ?, ?)
     ON CONFLICT(old_id) DO UPDATE SET
       worktree_id = excluded.worktree_id,
       created_at = excluded.created_at`
  ).run(oldId, worktreeId, now);
}

/**
 * Resolve an ID that may be historical to the ID that is current.
 *
 * Live worktrees win over aliases, always. An ID can be both — a worktree
 * created at a directory whose basename matches an ID some other worktree used
 * to have — and in that case the thing that exists now is the answer.
 *
 * @param db - Database instance
 * @param id - A worktree ID as supplied by a URL, a CLI argument, …
 * @returns The current worktree ID, or `null` when nothing resolves
 */
export function resolveWorktreeIdWithAlias(
  db: Database.Database,
  id: string
): string | null {
  if (!id) return null;

  const live = db.prepare('SELECT 1 FROM worktrees WHERE id = ?').get(id);
  if (live) return id;

  if (!hasAliasTable(db)) return null;

  const row = db
    .prepare('SELECT worktree_id FROM worktree_aliases WHERE old_id = ?')
    .get(id) as { worktree_id: string } | undefined;
  if (!row) return null;

  // An alias pointing at a worktree that is gone is not a redirect, it is a
  // dangling row (only reachable if foreign keys were off when it was deleted).
  const target = db.prepare('SELECT 1 FROM worktrees WHERE id = ?').get(row.worktree_id);
  return target ? row.worktree_id : null;
}

/**
 * Every historical ID recorded for one worktree, newest first.
 *
 * @param db - Database instance
 * @param worktreeId - Current worktree ID
 */
export function getWorktreeAliases(
  db: Database.Database,
  worktreeId: string
): WorktreeAlias[] {
  if (!hasAliasTable(db)) return [];

  const rows = db
    .prepare(
      `SELECT old_id, worktree_id, created_at
       FROM worktree_aliases
       WHERE worktree_id = ?
       ORDER BY created_at DESC, old_id ASC`
    )
    .all(worktreeId) as Array<{
    old_id: string;
    worktree_id: string;
    created_at: number;
  }>;

  return rows.map((row) => ({
    oldId: row.old_id,
    worktreeId: row.worktree_id,
    createdAt: row.created_at,
  }));
}

/**
 * Every ID that is currently answerable as an alias.
 *
 * Feeds `deriveWorktreeId`'s taken set: a brand-new worktree must not be minted
 * an ID that an alias already redirects somewhere else, or the redirect would
 * be shadowed and one of the two references would start pointing at the wrong
 * worktree (Issue #1621).
 *
 * @param db - Database instance
 */
export function getAliasedWorktreeIds(db: Database.Database): string[] {
  if (!hasAliasTable(db)) return [];

  const rows = db.prepare('SELECT old_id FROM worktree_aliases').all() as Array<{
    old_id: string;
  }>;
  return rows.map((row) => row.old_id);
}
