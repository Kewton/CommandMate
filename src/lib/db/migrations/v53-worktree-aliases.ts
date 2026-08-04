/**
 * Migration v53: worktree_aliases (Issue #1621, Phase 2).
 *
 * Every ID a worktree has ever answered to, mapped to the ID it answers to now.
 * #1644 froze the ID at first registration, but rows written before that carry
 * a branch-derived ID, and #1645 will renumber them. The moment an ID moves,
 * every URL a human kept — an open tab, a phone, a PWA shortcut, a bookmark, a
 * script's `commandmate send <id>` — points at something that no longer
 * resolves. An alias makes the old ID keep working instead of 404ing.
 *
 * `old_id` is the primary key: one historical ID resolves to exactly one
 * worktree. `worktree_id` cascades, so a deleted worktree takes its aliases
 * with it rather than leaving redirects to a dead row. (The column is also
 * named `worktree_id`, so `getWorktreeChildTables` finds this table on both of
 * its axes and a *rename* re-points the alias as well — an ID renamed twice
 * still resolves in one hop, never a chain.)
 *
 * Resolution order is worktrees-first, aliases-second, and the ID minter is
 * told about alias IDs too (`deriveWorktreeId`'s taken set), so a fresh
 * worktree cannot be handed an ID that an alias would otherwise shadow. Both
 * halves are needed: the index below exists for the second lookup, which runs
 * on every API request whose worktree ID is not a live row.
 *
 * Timestamps are epoch milliseconds (INTEGER), matching v44 onward.
 */

import type { Migration } from './runner';

export const v53_migrations: Migration[] = [
  {
    version: 53,
    name: 'add-worktree-aliases',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS worktree_aliases (
          old_id TEXT PRIMARY KEY,
          worktree_id TEXT NOT NULL REFERENCES worktrees(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL
        );
      `);

      // Aliases are read by old_id (the PK covers that) and swept by
      // worktree_id whenever a worktree is renamed or deleted.
      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_worktree_aliases_worktree_id
          ON worktree_aliases(worktree_id);
      `);
    },
    down: (db) => {
      db.exec('DROP INDEX IF EXISTS idx_worktree_aliases_worktree_id;');
      db.exec('DROP TABLE IF EXISTS worktree_aliases;');
    },
  },
];
