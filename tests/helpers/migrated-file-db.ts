/**
 * A migrated, file-backed SQLite database for a unit test — without an fsync
 * per commit (Issue #4212).
 *
 * `runMigrations()` commits once per migration (~65 transactions on a fresh
 * file). With SQLite's default `synchronous = FULL` every commit waits for the
 * disk to flush the rollback journal and the database file. On an idle Mac that
 * is ~45ms for the whole schema, but the CI runner shares this machine with the
 * workers' verifications: with eight processes doing `write`+`fsync` on the same
 * disk, one fresh-file `runMigrations()` measured a median of 4.2s and a maximum
 * of 13.8s (2026-11-07). A synchronous `beforeEach` that takes 20s or more is
 * reported by Vitest as "Hook timed out in 20000ms" once it returns
 * (`withTimeout` compares the elapsed time after a sync hook) — which is what
 * `relay-hold-resolve-4082` (shard 4/4) and `cross-device-dismissal-episode-3798`
 * (shard 1/4) hit in develop push run 42293211705. Nothing was left pending: no
 * promise, timer or server; the hook was waiting on the disk.
 *
 * `synchronous = OFF` hands each commit to the OS without waiting for the flush.
 * Under the same load the same migration measured a median of 29ms. What a test
 * observes is unchanged: the rows are in the file for any other connection
 * (a reopened one, a racing second connection) — only a power cut could lose
 * them, and the file is a `mkdtemp` sandbox removed in `afterEach`. The pragma is
 * per connection, so a test that reopens the file through this helper gets it
 * again; a connection opened another way keeps SQLite's default.
 *
 * Never use this for the production database or for a test whose subject is
 * durability itself.
 */

import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

export interface MigratedFileDbOptions {
  /** `PRAGMA foreign_keys = ON` before the migrations (as `getDbInstance()` does). */
  foreignKeys?: boolean;
}

/** Open (or reopen) `file`, skip the per-commit fsync, and bring it to the current schema. */
export function openMigratedFileDb(file: string, options: MigratedFileDbOptions = {}): Database.Database {
  const db = new Database(file);
  db.pragma('synchronous = OFF');
  if (options.foreignKeys) db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
