/**
 * Row counts of every table of a SQLite database (Issue #4480).
 *
 * A refusal must leave no row behind; comparing the counts of every table before
 * and after a request shows that without naming the tables a route might write.
 */

import type Database from 'better-sqlite3';

/** `{ table: rowCount }` for every user table. */
export function rowCountsOfAllTables(db: Database.Database): Record<string, number> {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as { name: string }[];
  const counts: Record<string, number> = {};
  for (const { name } of tables) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${name.replace(/"/g, '""')}"`).get() as { n: number };
    counts[name] = row.n;
  }
  return counts;
}
