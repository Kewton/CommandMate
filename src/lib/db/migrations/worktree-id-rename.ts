/**
 * Moving a worktree's primary key without losing anything hanging off it.
 *
 * Lives under `migrations/` for the same reason `worktree-child-tables.ts` does,
 * and it is not a stylistic choice: the Phase 4 renumbering (#1645) needs this
 * logic, and a migration that imports `worktree-db.ts` inherits every
 * `vi.mock('@/lib/db/worktree-db')` in the suite — four suites do exactly that
 * today, and it is what made `runMigrations` throw
 * `No "getDeletableWorktreeChildTables" export is defined` before v52 was moved.
 * The same reasoning applies to `worktree-alias-db.ts`, so the alias INSERT is
 * written here and `recordWorktreeAlias` delegates to it rather than the other
 * way round.
 *
 * Issue #1151 (preserve children across a rename), #1621 (FK-less tables,
 * aliases), #1645 (bulk renumbering).
 */

import type Database from 'better-sqlite3';
import {
  getWorktreeChildTables,
  getWriteGuardedTables,
  type WorktreeChildTable,
} from './worktree-child-tables';

/** Whether `worktree_aliases` exists in this database. */
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
 * The implementation behind `recordWorktreeAlias` (`worktree-alias-db.ts`),
 * kept here so migrations can reach it without importing that module. See that
 * function's doc comment for the rules; in short:
 *
 * - a self-alias is dropped (it would resolve to itself);
 * - an alias whose `old_id` equals the destination is deleted, because that ID
 *   names a live worktree again and the live row must win;
 * - re-recording an existing `old_id` re-points it, so A→B→C resolves A→C in
 *   one hop rather than a chain.
 *
 * @param db - Database instance (caller supplies the transaction, if any)
 * @param oldId - The ID that is being retired
 * @param worktreeId - The ID it should resolve to from now on
 * @param now - Timestamp in epoch milliseconds
 */
export function recordWorktreeAliasRow(
  db: Database.Database,
  oldId: string,
  worktreeId: string,
  now: number
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
 * Delete every child row pointing at any of `worktreeIds`.
 *
 * Deliberately covers *all* deletable child tables, not just the FK-less ones:
 * doing so makes deletion correct even when `PRAGMA foreign_keys` is off, and
 * the extra statements against CASCADE tables remove rows that would have been
 * removed anyway. Append-only ledgers are skipped (see getWriteGuardedTables).
 * Must run before the parent row is deleted (Issue #1621).
 */
export function deleteWorktreeChildRows(
  db: Database.Database,
  worktreeIds: string[],
  children: WorktreeChildTable[] = getWorktreeChildTables(db)
): void {
  if (worktreeIds.length === 0) return;

  const { noDelete } = getWriteGuardedTables(db);
  const placeholders = worktreeIds.map(() => '?').join(',');
  for (const { table, column } of children) {
    if (noDelete.has(table)) continue;
    db.prepare(
      `DELETE FROM "${table}" WHERE "${column}" IN (${placeholders})`
    ).run(...worktreeIds);
  }
}

/**
 * Rename a worktree row's primary key from `oldId` to `newId`, re-pointing every
 * child table's foreign key so no CASCADE deletion occurs. This is what makes a
 * same-directory branch switch preserve chat history and all related data
 * instead of destroying it (Issue #1151).
 *
 * "Every child table" means every table carrying a worktree reference, not just
 * the ones that declare a foreign key: `tasks`, `verification_runs` and
 * `skill_operations` do not, and used to be left addressing an ID that no
 * longer resolves (Issue #1621).
 *
 * Append-only ledgers are the one exception, and the schema states it itself —
 * `skill_operations` aborts any UPDATE (#1234). An immutable audit row records
 * what happened under the identity in force at the time, and rewriting it is
 * precisely what its trigger exists to prevent; attempting it does not fail
 * quietly either, it aborts the enclosing transaction and takes the rename with
 * it (measured). See getWriteGuardedTables.
 *
 * Must be called inside a transaction. `PRAGMA defer_foreign_keys` defers FK
 * enforcement to COMMIT, letting us repoint the parent PK and its children in
 * any order without needing `ON UPDATE CASCADE` on every constraint.
 *
 * @param db - Database instance
 * @param oldId - Current primary key
 * @param newId - Primary key it should have
 * @param now - Timestamp recorded on the alias row (epoch milliseconds)
 */
export function renameWorktreeIdPreservingChildren(
  db: Database.Database,
  oldId: string,
  newId: string,
  now: number = Date.now()
): void {
  if (oldId === newId) return;

  const oldExists = db.prepare('SELECT 1 FROM worktrees WHERE id = ?').get(oldId);
  if (!oldExists) return;

  // Defer FK checks until COMMIT so the parent PK and child FKs can be updated
  // independently. Resets automatically at the end of the transaction.
  db.pragma('defer_foreign_keys = ON');

  const newExists = db.prepare('SELECT 1 FROM worktrees WHERE id = ?').get(newId);
  const { noUpdate } = getWriteGuardedTables(db);
  const allChildren = getWorktreeChildTables(db);
  const children = allChildren.filter(({ table }) => !noUpdate.has(table));

  if (newExists) {
    // Collision guard. `path` is UNIQUE so two rows for the same directory
    // should never coexist, but if the DB is already inconsistent keep the
    // destination row's data and fold in the source's non-conflicting children.
    for (const { table, column } of children) {
      db.prepare(
        `UPDATE OR IGNORE "${table}" SET "${column}" = ? WHERE "${column}" = ?`
      ).run(newId, oldId);
    }
    // Conflicting leftovers are dropped explicitly rather than left to CASCADE:
    // tables without a foreign key never cascade, so relying on the parent
    // delete alone would strand their rows on a dead ID (#1621).
    deleteWorktreeChildRows(db, [oldId], allChildren);
    db.prepare('DELETE FROM worktrees WHERE id = ?').run(oldId);
    recordWorktreeAliasRow(db, oldId, newId, now);
    return;
  }

  // Normal rename: move the parent PK, then repoint all child rows.
  db.prepare('UPDATE worktrees SET id = ? WHERE id = ?').run(newId, oldId);
  for (const { table, column } of children) {
    db.prepare(
      `UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`
    ).run(newId, oldId);
  }

  // The rename is what retires `oldId`, so this is the one place that knows an
  // alias is needed. Recording it here (rather than at each call site) means
  // every path that moves an ID — sync, the #1645 bulk migration, a future
  // directory move — keeps old URLs and old `commandmate send <id>` lines
  // answering, without any of them having to remember to.
  //
  // Runs AFTER the child sweep on purpose: `worktree_aliases` carries a
  // `worktree_id`, so the loop above has already re-pointed the aliases this
  // worktree accumulated earlier. A→B→C therefore leaves A→C and B→C, never a
  // chain that resolution would have to walk.
  recordWorktreeAliasRow(db, oldId, newId, now);
}
