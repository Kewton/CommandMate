/**
 * Live-schema introspection for "which tables reference a worktree".
 *
 * Lives under `migrations/` rather than next to `worktree-db.ts` because the
 * dependency has to point this way: migration v52 sweeps orphans with the same
 * enumeration the runtime uses, and a migration that imports `worktree-db.ts`
 * inherits every mock of it — `vi.mock('@/lib/db/worktree-db')` in an unrelated
 * suite made `runMigrations` throw `No "getDeletableWorktreeChildTables" export
 * is defined` (measured across 5 tests). Schema introspection is the more
 * foundational of the two, so it is what the other side imports.
 *
 * Issue #1621.
 */

import Database from 'better-sqlite3';

/** A table referencing `worktrees`, and the column that does the referencing. */
export interface WorktreeChildTable {
  table: string;
  column: string;
}

/** Conventional name of the column holding a worktree reference. */
const WORKTREE_REFERENCE_COLUMN = 'worktree_id';

/**
 * Discover every table that references a worktree, along with the referencing
 * column. Derived dynamically from the live schema so it never drifts out of
 * sync with future migrations that add child tables.
 *
 * Two sources are unioned:
 *
 * 1. a `worktree_id` column, **whether or not** the table declares a foreign key
 * 2. a declared foreign key to `worktrees(id)`, whatever the column is named
 *
 * Source 1 is what Issue #1621 adds. FK metadata alone (all this did before)
 * silently skipped `tasks` (#1548), `verification_runs` (#1544) and
 * `skill_operations` (#1428): all three carry a `worktree_id` but declare no
 * constraint, so a rename left them pointing at an ID that no longer exists and
 * a delete left them behind as orphans — no CASCADE fires without a FK.
 *
 * Source 2 is kept so a future table whose FK column is *not* named
 * `worktree_id` keeps being followed; dropping it would be a regression for
 * every table #1151 already handled.
 *
 * Issue #1151, #1621.
 */
export function getWorktreeChildTables(db: Database.Database): WorktreeChildTable[] {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'"
    )
    .all() as Array<{ name: string }>;

  const children: WorktreeChildTable[] = [];
  const seen = new Set<string>();
  const add = (table: string, column: string): void => {
    // JSON encoding keeps the pair unambiguous whatever the identifiers contain.
    const key = JSON.stringify([table, column]);
    if (seen.has(key)) return;
    seen.add(key);
    children.push({ table, column });
  };

  for (const { name: tableName } of tables) {
    if (tableName === 'worktrees') continue;

    // PRAGMA identifiers cannot be bound; `tableName` comes from sqlite_master,
    // not user input, so string interpolation here is safe.
    const columns = db.prepare(`PRAGMA table_info("${tableName}")`).all() as Array<{
      name: string;
    }>;
    if (columns.some((column) => column.name === WORKTREE_REFERENCE_COLUMN)) {
      add(tableName, WORKTREE_REFERENCE_COLUMN);
    }

    const fks = db.prepare(`PRAGMA foreign_key_list("${tableName}")`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
    }>;
    for (const fk of fks) {
      if (fk.table === 'worktrees' && (fk.to === 'id' || fk.to === null)) {
        add(tableName, fk.from);
      }
    }
  }
  return children;
}

/**
 * Tables the schema itself refuses to let us rewrite, per statement kind.
 *
 * An append-only ledger enforces itself with a `BEFORE UPDATE` / `BEFORE DELETE`
 * trigger that calls `RAISE(ABORT, ...)`; `skill_operations` declares both
 * (#1234, migrations v44/v48). Such a table carries a `worktree_id` yet is
 * deliberately *not* owned by its worktree's lifetime: `querySkillOperationAudit`
 * reads it across every worktree for the dashboard feed, exactly like v51 keeps
 * `task_events` alive after its task is gone. Sweeping it is not cleanup, it is
 * destroying audit history — and it does not even fail safely: the trigger
 * aborts the statement, which rolls back the whole enclosing transaction, so a
 * blind sweep breaks worktree deletion outright (measured: `deleteWorktreesByIds`
 * threw `skill_operations is append-only` and the worktree row survived; the
 * same sweep inside migration v52 fails startup).
 *
 * Detected from trigger SQL rather than by table name so a future ledger is
 * protected the moment it declares its guard (Issue #1621).
 */
export function getWriteGuardedTables(db: Database.Database): {
  noUpdate: Set<string>;
  noDelete: Set<string>;
} {
  const triggers = db
    .prepare("SELECT tbl_name, sql FROM sqlite_master WHERE type = 'trigger'")
    .all() as Array<{ tbl_name: string; sql: string | null }>;

  const noUpdate = new Set<string>();
  const noDelete = new Set<string>();
  for (const trigger of triggers) {
    if (!trigger.sql) continue;
    if (!/\bRAISE\s*\(\s*ABORT/i.test(trigger.sql)) continue;
    if (/\bBEFORE\s+UPDATE\b/i.test(trigger.sql)) noUpdate.add(trigger.tbl_name);
    if (/\bBEFORE\s+DELETE\b/i.test(trigger.sql)) noDelete.add(trigger.tbl_name);
  }
  return { noUpdate, noDelete };
}

/**
 * Child tables whose rows a worktree actually owns — everything
 * getWorktreeChildTables reports, minus the append-only ledgers that outlive it.
 * This is the set a delete or an orphan sweep may touch (Issue #1621).
 */
export function getDeletableWorktreeChildTables(
  db: Database.Database
): WorktreeChildTable[] {
  const { noDelete } = getWriteGuardedTables(db);
  return getWorktreeChildTables(db).filter(({ table }) => !noDelete.has(table));
}
