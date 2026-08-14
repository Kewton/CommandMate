/**
 * Migration v56: record where each verification gate was declared (Issue #1791).
 *
 * An execution contract can now carry gate *definitions* of its own, not just a
 * selection of the repository's (#1756 案 B). That is what stops an orchestrator
 * from having to append an Issue-specific gate to `.commandmate/verify.yaml` —
 * a file that stays inside the work-evidence change set, so a worktree carrying
 * nothing but that append reads as "the agent did work".
 *
 * The separation is only real if a reader can see it. Two gates in one report
 * spell their ids the same way whether the repository declared them or one
 * delegation did, and the contract's copy is not on disk to be checked against.
 * Without this column, per-delegation gates are a second verify.yaml that
 * nothing announces — a run could be green on criteria the repository never
 * agreed to, and its report would look identical to one that passed the real
 * ones.
 *
 * Nullable, with no backfill and no default. Rows written before this migration
 * were produced by a runner that had no contract gates at all, so `verify.yaml`
 * would be *almost* true of them and outright wrong for the built-ins — and
 * verification history is evidence, which is not rewritten to make a column
 * look complete. null therefore reads as "written before v56, nobody recorded
 * this", the same discipline `timingsMeasured` uses for pre-#1625 timestamps.
 *
 * The CHECK mirrors VERIFICATION_GATE_SOURCES in verification-db.ts, for the
 * reason v49's `trigger` CHECK does: a vocabulary that lives only in the writer
 * lets a typo land as a new bucket nothing queries.
 */

import type { Migration } from './runner';

export const v56_migrations: Migration[] = [
  {
    version: 56,
    name: 'add-source-to-verification-gate-results',
    up: (db) => {
      // `ADD COLUMN IF NOT EXISTS` does not exist in SQLite, and the rollback
      // below deliberately leaves the column in place — so a database rolled
      // back past v56 and migrated forward again reaches this statement with
      // the column already there. Without the guard that upgrade path dies on
      // "duplicate column name".
      const columns = db
        .prepare('PRAGMA table_info(verification_gate_results)')
        .all() as Array<{ name: string }>;
      if (columns.some((column) => column.name === 'source')) return;

      db.exec(`
        ALTER TABLE verification_gate_results ADD COLUMN source TEXT
          CHECK (source IS NULL OR source IN ('builtin', 'verify.yaml', 'contract'));
      `);
    },
    down: () => {
      // SQLite drops columns only by rebuilding the table, which would rewrite
      // every historical gate verdict to remove one nullable column. Same
      // no-op rollback as v35/v36.
    },
  },
];
