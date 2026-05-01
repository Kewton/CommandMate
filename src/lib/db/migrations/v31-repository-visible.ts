/** Migration v31: Add visible column to repositories table (Issue #690).
 *
 * Adds a `visible` flag that controls whether a repository's worktrees are
 * shown in the sidebar. This is independent of the `enabled` flag (Issue #190),
 * which controls sync exclusion.
 *
 * Concept separation (Issue #690):
 *   - enabled: sync inclusion (used by disableRepository / restoreRepository)
 *   - visible: sidebar visibility (toggled from the Repositories screen)
 *
 * disableRepository / restoreRepository do NOT touch `visible`, and the
 * Repositories screen visibility toggle does NOT touch `enabled`.
 *
 * Default 1 (visible) so existing repositories are unaffected after migration.
 */

import type { Migration } from './runner';

export const v31_migrations: Migration[] = [
  {
    version: 31,
    name: 'add-repository-visible',
    up: (db) => {
      db.exec(
        'ALTER TABLE repositories ADD COLUMN visible INTEGER NOT NULL DEFAULT 1;'
      );
    },
    down: (db) => {
      db.exec('ALTER TABLE repositories DROP COLUMN visible;');
    },
  },
];
