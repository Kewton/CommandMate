/**
 * The record of which mem prompt an instance was shown (Issue #4226, design
 * `docs/design/mem-prompt-4226.md` §4.2・§4.3). Table `suggestion_shown` (v70).
 *
 * Synchronous only: the quiet route reads and writes it in the build of its last
 * await (INV-A, §3.6), so no other request of this process runs in between.
 *
 * The key is (worktree, instance, code, scope); the value is what the prompt was shown
 * for (the instance's incarnation, the conversation boundary, the fingerprint). Rows
 * are removed in the same transaction as a write, never by a timer (D8):
 *  - the current scope's codes that no longer hold (`clear`);
 *  - codes the rule table no longer has (`knownCodes`);
 *  - instances off the roster whose incarnation is gone (`rosterInstanceIds`);
 *  - scopes whose root is no longer registered or whose branch git no longer has
 *    (`liveScopeHashes`).
 * A worktree's rename moves its rows and its delete takes them (a worktree child).
 *
 * The rows of a worktree are read once and sorted in JS: the set of live scopes is
 * (roots × branches), which a `NOT IN (?, …)` could push past SQLite's variable limit.
 *
 * @module lib/db/suggestion-shown-db
 */

import type Database from 'better-sqlite3';
import { instanceIncarnationAlive } from '@/lib/mem/incarnation';

export interface ShownRow {
  code: string;
  instanceIncarnation: string | null;
  boundaryId: string | null;
  fingerprint: string;
  shownAt: number;
}

interface RawShownRow {
  worktree_id: string;
  instance_id: string;
  code: string;
  instance_incarnation: string | null;
  boundary_id: string | null;
  scope_hash: string;
  fingerprint: string;
  shown_at: number;
}

const toShown = (raw: RawShownRow): ShownRow => ({
  code: raw.code,
  instanceIncarnation: raw.instance_incarnation,
  boundaryId: raw.boundary_id,
  fingerprint: raw.fingerprint,
  shownAt: raw.shown_at,
});

/** The rows of one (worktree, instance) in one scope, by code. Other scopes are not read. */
export function readShown(db: Database.Database, worktreeId: string, instanceId: string, scopeHash: string): Map<string, ShownRow> {
  const rows = db
    .prepare('SELECT * FROM suggestion_shown WHERE worktree_id = ? AND instance_id = ? AND scope_hash = ?')
    .all(worktreeId, instanceId, scopeHash) as RawShownRow[];
  return new Map(rows.map((raw) => [raw.code, toShown(raw)]));
}

export interface SettleShownInput {
  worktreeId: string;
  instanceId: string;
  /** The scope the request was judged in: `write` and `clear` apply to it only. */
  scopeHash: string;
  /** Rows to put (insert or replace the value). */
  write: ShownRow[];
  /** Codes of the current scope that were evaluated and do not hold. */
  clear: string[];
  /** The instances the worktree's roster resolves to now (derived primary included). */
  rosterInstanceIds: string[];
  /** The codes the rule table has. */
  knownCodes: readonly string[];
  /** Every scope to keep: registered roots × (git's local branches ∪ detached), and the current one. */
  liveScopeHashes: ReadonlySet<string>;
}

/** Write and clean up in one transaction (§4.3). */
export function settleShown(db: Database.Database, input: SettleShownInput): void {
  const upsert = db.prepare(
    `INSERT INTO suggestion_shown (worktree_id, instance_id, code, instance_incarnation, boundary_id, scope_hash, fingerprint, shown_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (worktree_id, instance_id, code, scope_hash) DO UPDATE SET
       instance_incarnation = excluded.instance_incarnation,
       boundary_id = excluded.boundary_id,
       fingerprint = excluded.fingerprint,
       shown_at = excluded.shown_at`
  );
  const remove = db.prepare('DELETE FROM suggestion_shown WHERE worktree_id = ? AND instance_id = ? AND code = ? AND scope_hash = ?');
  db.transaction(() => {
    for (const row of input.write) {
      upsert.run(input.worktreeId, input.instanceId, row.code, row.instanceIncarnation, row.boundaryId, input.scopeHash, row.fingerprint, row.shownAt);
    }
    for (const code of input.clear) remove.run(input.worktreeId, input.instanceId, code, input.scopeHash);
    const known = new Set(input.knownCodes);
    const roster = new Set(input.rosterInstanceIds);
    const rows = db.prepare('SELECT * FROM suggestion_shown WHERE worktree_id = ?').all(input.worktreeId) as RawShownRow[];
    for (const row of rows) {
      const gone =
        !input.liveScopeHashes.has(row.scope_hash) ||
        (row.instance_id === input.instanceId && !known.has(row.code)) ||
        (!roster.has(row.instance_id) && (row.instance_incarnation === null || !instanceIncarnationAlive(db, row.instance_incarnation)));
      if (gone) remove.run(row.worktree_id, row.instance_id, row.code, row.scope_hash);
    }
  })();
}

/** The number of rows of a worktree (tests, the bound of §4.3). */
export function countShown(db: Database.Database, worktreeId: string, instanceId?: string): number {
  const row = (
    instanceId === undefined
      ? db.prepare('SELECT COUNT(*) AS n FROM suggestion_shown WHERE worktree_id = ?').get(worktreeId)
      : db.prepare('SELECT COUNT(*) AS n FROM suggestion_shown WHERE worktree_id = ? AND instance_id = ?').get(worktreeId, instanceId)
  ) as { n: number };
  return row.n;
}
