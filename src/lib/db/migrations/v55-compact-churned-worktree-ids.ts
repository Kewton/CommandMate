/**
 * Migration v55: fold worktree IDs that ran away back onto their directory name
 * (Issue #1658).
 *
 * ## What went wrong
 *
 * `syncWorktreesToDB` resolved "which ID does this path already own?" against
 * `worktrees.repository_path`, but identity lives in `worktrees.path` — that is
 * the `NOT NULL UNIQUE` column, one row per directory for the whole table.
 * `repository_path` only records which scan root last upserted the row, and when
 * the *same* git repository is registered under two scan roots (a repository and
 * one of its own linked worktrees, both listed in `WORKTREE_REPOS`),
 * `git worktree list` returns the identical path set from either one. The column
 * then ping-pongs, the per-repository lookup came up empty on whichever pass did
 * not write it last, and the row's ID was re-derived — against a taken set
 * containing its own current ID and every ID it had already been renamed away
 * from. `deriveWorktreeId` answered by walking one rung further up the digest
 * ladder, so every sync appended another 8 hex digits:
 *
 *     commandagent-bon0-run
 *     commandagent-bon0-run-2f4530fe
 *     commandagent-bon0-run-2f4530fe1cf1f9f8
 *     commandagent-bon0-run-2f4530fe1cf1f9f85d499f80
 *     …
 *
 * Production reached 81 characters, at which point the tmux session name derived
 * from the ID no longer matched the running session and the UI lost it.
 *
 * ## Why a migration, and not just the fix
 *
 * The fix stops the growth; it does not undo it, because it works by *keeping*
 * whatever ID a path already has. Left alone, those five rows would stay
 * permanently on their inflated IDs and the abandoned rungs would stay reserved
 * forever (the minter counts aliases as taken). This migration is the one moment
 * they are collapsed.
 *
 * ## The rules
 *
 * - A row is compacted only when re-deriving its ID — with the path's **own**
 *   history excluded from the taken set, which is precisely what was missing —
 *   yields something *shorter*. Nothing else moves; a row whose short ID is
 *   genuinely taken by another directory keeps what it has.
 * - Another row's ID and another row's alias are never taken. Live worktrees beat
 *   aliases at resolution, so handing out an ID somebody else still answers to
 *   would silently redirect their bookmarks (the same rule v54 follows).
 * - The ID a row is leaving becomes an alias, via
 *   {@link renameWorktreeIdPreservingChildren} — that is what keeps the URLs,
 *   open tabs and `commandmate send <id>` lines that were minted during the
 *   churn answering.
 * - The **intermediate rungs** are deleted. Every one of them points at the same
 *   worktree as the rung above it, and none survived longer than the second it
 *   took the next sync to replace it (the production alias rows are ~1s apart);
 *   keeping them would reserve those IDs for good. Aliases that are not
 *   ladder-shaped — `commandagent-develop-develop`, `commandagent-develop-
 *   detached-1c64d87f`, anything from the branch-derived era — are genuine former
 *   names and are kept. {@link isDerivedWorktreeId} is what tells them apart.
 *
 * No temporary-ID staging (unlike v54): a destination is only ever chosen from
 * IDs no live row holds, so `renameWorktreeIdPreservingChildren` can never reach
 * its merge-and-delete collision branch.
 */

import type { Migration } from './runner';
import path from 'path';
import { deriveWorktreeId, isDerivedWorktreeId } from '@/lib/git/worktree-id';
import { renameWorktreeIdPreservingChildren } from './worktree-id-rename';

interface WorktreeIdRow {
  id: string;
  path: string;
}

interface AliasRow {
  oldId: string;
  worktreeId: string;
}

export interface WorktreeIdCompactionPlan {
  /** Rows to rename, in row order; rows keeping their ID are omitted. */
  renames: Array<{ oldId: string; newId: string }>;
  /** Alias `old_id`s to delete: ladder rungs a compaction leaves behind. */
  droppedAliasIds: string[];
}

/**
 * Decide which rows collapse, and which of their aliases go with them.
 *
 * Exported for the unit tests: the rules (self-history exclusion, "shorter
 * only", ladder-vs-genuine alias) are the interesting part and are a pure
 * function of the rows plus the aliases.
 *
 * @param rows - Every worktree row, `id` and `path`
 * @param aliases - Every alias row
 * @internal
 */
export function planWorktreeIdCompaction(
  rows: ReadonlyArray<WorktreeIdRow>,
  aliases: ReadonlyArray<AliasRow>
): WorktreeIdCompactionPlan {
  const aliasesByTarget = new Map<string, string[]>();
  for (const alias of aliases) {
    const list = aliasesByTarget.get(alias.worktreeId);
    if (list) list.push(alias.oldId);
    else aliasesByTarget.set(alias.worktreeId, [alias.oldId]);
  }

  const reserved = new Set([...rows.map((row) => row.id), ...aliases.map((a) => a.oldId)]);
  const assigned = new Set<string>();
  const renames: Array<{ oldId: string; newId: string }> = [];
  const droppedAliasIds: string[] = [];

  for (const row of rows) {
    const resolvedPath = path.resolve(row.path);
    const ownAliasIds = aliasesByTarget.get(row.id) ?? [];

    // The row's own history cannot block the row: its current ID and every ID it
    // already answers to are exactly the rungs it is climbing away from.
    const taken = new Set([...reserved, ...assigned]);
    taken.delete(row.id);
    for (const ownAliasId of ownAliasIds) taken.delete(ownAliasId);

    const newId = deriveWorktreeId(resolvedPath, taken);

    // Only ever collapse. A longer or equal answer means the short forms are
    // genuinely spoken for by other directories, and moving would buy nothing.
    if (newId.length >= row.id.length) {
      assigned.add(row.id);
      continue;
    }

    assigned.add(newId);
    renames.push({ oldId: row.id, newId });

    for (const ownAliasId of ownAliasIds) {
      // Strictly longer than the ID we are landing on, and of a shape only this
      // path's own derivation produces: an abandoned rung, nothing else.
      if (ownAliasId.length > newId.length && isDerivedWorktreeId(ownAliasId, resolvedPath)) {
        droppedAliasIds.push(ownAliasId);
      }
    }
  }

  return { renames, droppedAliasIds };
}

export const v55_migrations: Migration[] = [
  {
    version: 55,
    name: 'compact-churned-worktree-ids',
    up: (db) => {
      const rows = db
        .prepare('SELECT id, path FROM worktrees ORDER BY id')
        .all() as WorktreeIdRow[];
      if (rows.length === 0) {
        console.log('No worktrees to compact');
        return;
      }

      const aliasTableExists =
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'worktree_aliases'"
          )
          .get() !== undefined;
      const aliases: AliasRow[] = aliasTableExists
        ? (
            db
              .prepare('SELECT old_id, worktree_id FROM worktree_aliases ORDER BY old_id')
              .all() as Array<{ old_id: string; worktree_id: string }>
          ).map((row) => ({ oldId: row.old_id, worktreeId: row.worktree_id }))
        : [];

      const { renames, droppedAliasIds } = planWorktreeIdCompaction(rows, aliases);
      if (renames.length === 0) {
        console.log(`No churned worktree IDs to compact (${rows.length} row(s) checked)`);
        return;
      }

      // Drop the abandoned rungs before the rename, so the ID being vacated is
      // the only historical name this worktree is left with besides its genuine
      // former names.
      if (aliasTableExists && droppedAliasIds.length > 0) {
        const deleteAlias = db.prepare('DELETE FROM worktree_aliases WHERE old_id = ?');
        for (const aliasId of droppedAliasIds) deleteAlias.run(aliasId);
      }

      // One timestamp for every alias this migration writes, so the rows read as
      // a single event (same reasoning as v54).
      const now = Date.now();
      for (const rename of renames) {
        renameWorktreeIdPreservingChildren(db, rename.oldId, rename.newId, now);
        console.log(`Compacted worktree ${rename.oldId} -> ${rename.newId}`);
      }

      console.log(
        `Compacted ${renames.length} of ${rows.length} worktree ID(s); ` +
          `dropped ${droppedAliasIds.length} intermediate alias(es)`
      );
    },
    down: (db) => {
      // The inverse is well defined even though the intermediate rungs are gone:
      // the ID each row was compacted *from* was recorded as an alias by the
      // rename, and it is the longest ladder-shaped alias the row still has (all
      // the shorter rungs were deleted on the way forward). Genuine former names
      // are not ladder-shaped, so they are never mistaken for it.
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

      const rows = db
        .prepare('SELECT id, path FROM worktrees ORDER BY id')
        .all() as WorktreeIdRow[];
      const deleteAlias = db.prepare('DELETE FROM worktree_aliases WHERE old_id = ?');
      const now = Date.now();
      let restored = 0;

      for (const row of rows) {
        const resolvedPath = path.resolve(row.path);
        const candidates = (
          db
            .prepare('SELECT old_id FROM worktree_aliases WHERE worktree_id = ?')
            .all(row.id) as Array<{ old_id: string }>
        )
          .map((alias) => alias.old_id)
          .filter(
            (oldId) => oldId.length > row.id.length && isDerivedWorktreeId(oldId, resolvedPath)
          )
          .sort((a, b) => b.length - a.length || a.localeCompare(b));

        const previousId = candidates[0];
        if (!previousId) continue;

        deleteAlias.run(previousId);
        renameWorktreeIdPreservingChildren(db, row.id, previousId, now);
        // The forward ID is now the historical one; the rollback should not
        // leave it redirecting back to the ID it just undid.
        deleteAlias.run(row.id);
        restored++;
      }

      console.log(`Rolled back ${restored} worktree ID compaction(s)`);
    },
  },
];
