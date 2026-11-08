/**
 * Incarnations: how long a worktree, or an instance of one, is the same thing
 * (Issue #4221, design §10.1・§10.4).
 *
 * An instance id is re-used (removed and added again, or kept with another tool),
 * and a worktree id comes back when the same path is made again (v54). An item
 * written by the earlier one must not be taken for the work of the later one, so
 * each holds a random id for its lifetime. Both tables are worktree children: a
 * rename moves them, a delete takes them.
 *
 * Database only, no imports of the roster: `agent-instances-db.ts` calls these.
 *
 * @module lib/mem/incarnation
 */

import { randomUUID } from 'crypto';
import type Database from 'better-sqlite3';

export interface InstanceIncarnation {
  cliToolId: string;
  incarnation: string;
}

export function getInstanceIncarnation(
  db: Database.Database,
  worktreeId: string,
  instanceId: string
): InstanceIncarnation | null {
  const row = db
    .prepare('SELECT cli_tool_id, incarnation FROM mem_instance_incarnations WHERE worktree_id = ? AND instance_id = ?')
    .get(worktreeId, instanceId) as { cli_tool_id: string; incarnation: string } | undefined;
  return row ? { cliToolId: row.cli_tool_id, incarnation: row.incarnation } : null;
}

export function listInstanceIncarnations(
  db: Database.Database,
  worktreeId: string
): Array<InstanceIncarnation & { instanceId: string }> {
  return (
    db
      .prepare('SELECT instance_id, cli_tool_id, incarnation FROM mem_instance_incarnations WHERE worktree_id = ?')
      .all(worktreeId) as Array<{ instance_id: string; cli_tool_id: string; incarnation: string }>
  ).map((row) => ({ instanceId: row.instance_id, cliToolId: row.cli_tool_id, incarnation: row.incarnation }));
}

/** Start a new incarnation, replacing any row for the id. Returns it. */
export function startInstanceIncarnation(
  db: Database.Database,
  worktreeId: string,
  instanceId: string,
  cliToolId: string,
  now: number = Date.now()
): string {
  const incarnation = randomUUID();
  db.prepare(
    `INSERT INTO mem_instance_incarnations (worktree_id, instance_id, cli_tool_id, incarnation, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(worktree_id, instance_id) DO UPDATE SET
       cli_tool_id = excluded.cli_tool_id, incarnation = excluded.incarnation, created_at = excluded.created_at`
  ).run(worktreeId, instanceId, cliToolId, incarnation, now);
  return incarnation;
}

export function endInstanceIncarnation(db: Database.Database, worktreeId: string, instanceId: string): void {
  db.prepare('DELETE FROM mem_instance_incarnations WHERE worktree_id = ? AND instance_id = ?').run(worktreeId, instanceId);
}

/** The worktree's incarnation, or null when it has none (none is made). */
export function getWorktreeIncarnation(db: Database.Database, worktreeId: string): string | null {
  const row = db.prepare('SELECT incarnation FROM mem_worktree_incarnations WHERE worktree_id = ?').get(worktreeId) as
    | { incarnation: string }
    | undefined;
  return row ? row.incarnation : null;
}

/** The worktree's incarnation, made in this statement when it has none. */
export function getOrCreateWorktreeIncarnation(
  db: Database.Database,
  worktreeId: string,
  now: number = Date.now()
): string {
  const row = db
    .prepare('SELECT incarnation FROM mem_worktree_incarnations WHERE worktree_id = ?')
    .get(worktreeId) as { incarnation: string } | undefined;
  if (row) return row.incarnation;
  const incarnation = randomUUID();
  db.prepare('INSERT INTO mem_worktree_incarnations (worktree_id, incarnation, created_at) VALUES (?, ?, ?)').run(
    worktreeId,
    incarnation,
    now
  );
  return incarnation;
}

/**
 * Whether a worktree incarnation still exists under any id (2nd review 5).
 *
 * What the `worktree` condition of #4222 evaluates: a rename moves the row to the
 * new id, so it is alive; a delete (and a re-creation at the same path) removes
 * it, so it is not. Looked up by the incarnation, never by the stored id.
 */
export function worktreeIncarnationAlive(db: Database.Database, incarnation: string): boolean {
  return db.prepare('SELECT 1 FROM mem_worktree_incarnations WHERE incarnation = ?').get(incarnation) !== undefined;
}
