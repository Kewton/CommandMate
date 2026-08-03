/**
 * Migration v54: renumber every existing worktree to its path-derived ID
 * (Issue #1621 Phase 4, delivered by #1645).
 *
 * #1644 stopped the ID from moving on its own — `syncWorktreesToDB` now looks a
 * row up by path and keeps whatever ID it already carries. What it deliberately
 * did NOT do is touch the rows already in the database: those still hold
 * `sanitize(repoName)-sanitize(branch)`, so every one of them is still a
 * branch-derived ID that merely happens to be frozen. The failures #1621
 * enumerates are only really gone once the stored IDs are the directory's.
 *
 * This migration is the one moment the whole table moves at once, which is what
 * makes the two problems below real rather than theoretical.
 *
 * ## Why the renaming is staged through temporary IDs
 *
 * One worktree's NEW ID can be another worktree's CURRENT ID. The design's own
 * example: the directory registered today as `mycodebranchdesk-main` (repo
 * `MyCodeBranchDesk`, branch `main`) is at `.../commandmate-main`, so its new ID
 * is `commandmate-main` — which is exactly the shape another row could already
 * be using. Renaming pairwise would then hit
 * `renameWorktreeIdPreservingChildren`'s collision branch, which *merges* the
 * source into the destination and deletes the source row: silent data loss. A
 * straight swap (A→B, B→A) has no safe ordering at all. Every rename therefore
 * goes `old → cmate-mig54-<n> → new`, so no intermediate state can collide.
 *
 * ## Why an ID is never minted onto an ID somebody else is vacating
 *
 * A retired ID does not disappear, it becomes an alias, and live worktrees beat
 * aliases at resolution time. So if worktree B were handed `x` — the ID worktree
 * A is retiring — every bookmark of A's `x` would silently start landing on B.
 * The taken set therefore holds **every current worktree ID** and **every
 * pre-existing alias**, minus the row's own ID (which it is free to keep). A
 * blocked candidate falls back to `basename-<sha256(path)[0..8]>`, exactly as a
 * same-basename collision does.
 *
 * ## What follows the move, and what deliberately does not
 *
 * Child rows follow through `renameWorktreeIdPreservingChildren`, which
 * enumerates by `worktree_id` column rather than by declared foreign key — the
 * only reason `tasks` (#1548), `verification_runs` (#1544) and the aliases
 * themselves come along. `skill_operations` does NOT: it is an append-only
 * ledger whose `BEFORE UPDATE ... RAISE(ABORT)` trigger (#1234) would abort this
 * migration outright. Its rows keep the ID that was in force when they were
 * written, which is what an audit log is for, and the alias recorded here keeps
 * them resolvable.
 *
 * tmux sessions and in-process state cannot be reached from a migration. They
 * are reconciled at startup by `reconcileWorktreeSessionsFromAliases`, which
 * reads the very alias rows this migration writes (`server.ts`).
 */

import type { Migration } from './runner';
import path from 'path';
import { deriveWorktreeId } from '@/lib/git/worktree-id';
import { renameWorktreeIdPreservingChildren } from './worktree-id-rename';

interface WorktreeIdRow {
  id: string;
  path: string;
}

/**
 * Prefix for the intermediate IDs used by the two-stage renaming.
 *
 * Deliberately not a plausible directory basename, and the rows carrying it
 * exist only between the two loops below — both inside the migration's
 * transaction, so no reader ever observes one.
 */
const TEMP_ID_PREFIX = 'cmate-mig54-';

/**
 * Decide the new ID for every worktree row.
 *
 * Exported for the unit tests: the planning is the part with the interesting
 * rules (collision, self-retention, alias shadowing), and it is a pure function
 * of the rows plus the reserved set.
 *
 * @param rows - Every worktree row, `id` and `path`
 * @param aliasIds - IDs already answerable as aliases
 * @returns The renames to apply, in row order; rows keeping their ID are omitted
 * @internal
 */
export function planWorktreeIdRenumbering(
  rows: ReadonlyArray<WorktreeIdRow>,
  aliasIds: ReadonlyArray<string>
): Array<{ oldId: string; newId: string }> {
  const currentIds = new Set(rows.map((row) => row.id));
  const reserved = new Set([...currentIds, ...aliasIds]);
  const assigned = new Set<string>();
  const plan: Array<{ oldId: string; newId: string }> = [];

  for (const row of rows) {
    const taken = new Set([...reserved, ...assigned]);
    // A row is never blocked by its own ID: when the directory basename already
    // equals it, the right answer is "keep it" and no rename is emitted.
    taken.delete(row.id);

    const newId = deriveWorktreeId(path.resolve(row.path), taken);
    assigned.add(newId);
    if (newId !== row.id) plan.push({ oldId: row.id, newId });
  }

  return plan;
}

export const v54_migrations: Migration[] = [
  {
    version: 54,
    name: 'renumber-worktree-ids-from-path',
    up: (db) => {
      const rows = db
        .prepare('SELECT id, path FROM worktrees ORDER BY id')
        .all() as WorktreeIdRow[];
      if (rows.length === 0) {
        console.log('No worktrees to renumber');
        return;
      }

      const aliasTableExists =
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_aliases'"
          )
          .get() !== undefined;
      const aliasIds = aliasTableExists
        ? (db.prepare('SELECT old_id FROM worktree_aliases').all() as Array<{
            old_id: string;
          }>).map((row) => row.old_id)
        : [];

      const plan = planWorktreeIdRenumbering(rows, aliasIds);
      if (plan.length === 0) {
        console.log(`Worktree IDs already path-derived (${rows.length} row(s) checked)`);
        return;
      }

      // Temporary IDs must not collide with anything real, including an ID this
      // migration is about to hand out.
      const inUse = new Set([
        ...rows.map((row) => row.id),
        ...aliasIds,
        ...plan.map((entry) => entry.newId),
      ]);
      const tempIds = plan.map((_entry, index) => {
        let candidate = `${TEMP_ID_PREFIX}${index}`;
        for (let attempt = 1; inUse.has(candidate); attempt++) {
          candidate = `${TEMP_ID_PREFIX}${index}-${attempt}`;
        }
        inUse.add(candidate);
        return candidate;
      });

      // A single timestamp for every alias this migration writes, so the rows
      // read as one event. (`Date.now()` is called once rather than per row for
      // the same reason.)
      const now = Date.now();

      // Stage 1: park every row on an ID nothing else can want.
      plan.forEach((entry, index) => {
        renameWorktreeIdPreservingChildren(db, entry.oldId, tempIds[index], now);
      });
      // Stage 2: into the real IDs, now guaranteed free.
      plan.forEach((entry, index) => {
        renameWorktreeIdPreservingChildren(db, tempIds[index], entry.newId, now);
      });

      // Stage 1 recorded `oldId → temp` and stage 2 re-pointed it to
      // `oldId → newId` (aliases are a child table, so the sweep moved them).
      // What stage 2 also wrote is `temp → newId`, which is a redirect for an ID
      // that never left this transaction — drop it so it neither answers
      // requests nor blocks a future ID.
      const deleteAlias = aliasTableExists
        ? db.prepare('DELETE FROM worktree_aliases WHERE old_id = ?')
        : null;
      if (deleteAlias) {
        for (const tempId of tempIds) deleteAlias.run(tempId);
      }

      for (const entry of plan) {
        console.log(`Renumbered worktree ${entry.oldId} -> ${entry.newId}`);
      }
      console.log(
        `Renumbered ${plan.length} of ${rows.length} worktree(s) to path-derived IDs`
      );
    },
    down: (db) => {
      // The alias rows record where each ID came from, so the move is reversible
      // as long as they are still there. Same two-stage staging, in reverse.
      const aliasTableExists =
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_aliases'"
          )
          .get() !== undefined;
      if (!aliasTableExists) {
        console.log('No worktree_aliases table: nothing to roll back');
        return;
      }

      const aliases = db
        .prepare(
          `SELECT a.old_id, a.worktree_id
             FROM worktree_aliases AS a
             JOIN worktrees AS w ON w.id = a.worktree_id
            ORDER BY a.old_id`
        )
        .all() as Array<{ old_id: string; worktree_id: string }>;
      if (aliases.length === 0) {
        console.log('No worktree aliases to roll back');
        return;
      }

      const now = Date.now();
      const tempIds = aliases.map((_alias, index) => `${TEMP_ID_PREFIX}down-${index}`);
      aliases.forEach((alias, index) => {
        renameWorktreeIdPreservingChildren(db, alias.worktree_id, tempIds[index], now);
      });
      aliases.forEach((alias, index) => {
        renameWorktreeIdPreservingChildren(db, tempIds[index], alias.old_id, now);
      });

      const deleteAlias = db.prepare('DELETE FROM worktree_aliases WHERE old_id = ?');
      for (const tempId of tempIds) deleteAlias.run(tempId);
      // The forward IDs are now the historical ones; the rollback should not
      // leave them redirecting back to the IDs it just undid.
      for (const alias of aliases) deleteAlias.run(alias.worktree_id);

      console.log(`Rolled back ${aliases.length} worktree ID renumbering(s)`);
    },
  },
];
