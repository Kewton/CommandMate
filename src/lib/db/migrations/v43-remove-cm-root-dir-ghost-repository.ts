/**
 * Migration v43: delete the CM_ROOT_DIR ghost repository row (Issue #1339).
 *
 * Before #1328, `getRepositoryPaths()` returned CM_ROOT_DIR as if it were a
 * single repository path, and the sync route handed it to
 * `ensureEnvRepositoriesRegistered()`, which wrote it to `repositories` with
 * `is_env_managed = 1`. But CM_ROOT_DIR is the *container* of repositories, not
 * a repository: `git worktree list` run there returns nothing, so no `worktrees`
 * row was ever created for it. The result is a repository row with no worktrees
 * under it — visible in the repository management screen, absent from the
 * sidebar (which is driven by `worktrees`), and impossible for the user to tell
 * apart from a real entry.
 *
 * #1328 removed the discovery that created these rows but deliberately left the
 * existing rows alone. This migration is that clean-up.
 *
 * SCOPE: only the `is_env_managed = 1` row whose path is exactly CM_ROOT_DIR.
 * The `is_env_managed = 0` ghosts written by `disableRepository()` are a
 * different defect (#1346) and are not touched here.
 *
 * The three guards below exist because deleting a *legitimate* env-managed row
 * is not a harmless mistake: `ensureEnvRepositoriesRegistered()` recreates a
 * missing row with `enabled: true` (db-repository.ts:469), so a wrong delete
 * silently re-enables a repository the user had switched off, and drops their
 * `visible` / `display_name` alongside it. Every guard fails toward keeping the
 * row.
 *
 * Backward compatibility: a DB with no ghost row (the normal case for anyone who
 * never ran a pre-#1328 build) matches nothing and the migration is a no-op.
 */

import path from 'path';
import type { Migration } from './runner';

/**
 * The configured CM_ROOT_DIR, resolved the same way the ghost row's path was
 * written: `path.resolve()` over the raw env value (`resolveRepositoryPath()`).
 *
 * Deliberately NOT `getEnv()`: that falls back to `process.cwd()` when
 * CM_ROOT_DIR is unset (env.ts:218), which would aim this DELETE at whatever
 * directory the server happened to start in — quite plausibly a real repository.
 * An unset CM_ROOT_DIR must mean "skip", never "target cwd".
 *
 * Read straight from process.env rather than through env.ts so the migration
 * stays frozen: it must keep deleting exactly what the pre-#1328 code wrote,
 * whatever env.ts grows into later.
 *
 * @returns Resolved CM_ROOT_DIR, or null when it is not configured
 */
function getConfiguredRootDir(): string | null {
  // MCBD_ROOT_DIR is the pre-#76 name and still supported (env.ts ENV_MAPPING).
  const raw = process.env.CM_ROOT_DIR ?? process.env.MCBD_ROOT_DIR;
  if (!raw || !raw.trim()) {
    return null;
  }
  return path.resolve(raw.trim());
}

/**
 * WORKTREE_REPOS entries, resolved. These are the *legitimate* `is_env_managed`
 * rows: post-#1328 `getRepositoryPaths()` returns this list and nothing else.
 *
 * Parsed inline, mirroring `getRepositoryPaths()` (git/worktrees.ts:144), rather
 * than imported: worktrees.ts pulls in `@/lib/db`, whose barrel re-exports this
 * very migration list.
 *
 * @returns Resolved WORKTREE_REPOS paths (empty when unset)
 */
function getWorktreeRepoPaths(): string[] {
  const raw = process.env.WORKTREE_REPOS;
  if (!raw || !raw.trim()) {
    return [];
  }
  return raw
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((p) => path.resolve(p));
}

export const v43_migrations: Migration[] = [
  {
    version: 43,
    name: 'remove-cm-root-dir-ghost-repository',
    up: (db) => {
      // Guard 1: no CM_ROOT_DIR, no target. See getConfiguredRootDir().
      const rootDir = getConfiguredRootDir();
      if (!rootDir) {
        console.log('Migration 43: CM_ROOT_DIR is not set; no ghost row to remove');
        return;
      }

      // Guard 2: CM_ROOT_DIR may legitimately also be listed in WORKTREE_REPOS,
      // which makes its is_env_managed row real and its absence self-healing at
      // enabled=true. Never delete a row the env still asks for.
      if (getWorktreeRepoPaths().includes(rootDir)) {
        console.log(
          `Migration 43: ${rootDir} is a WORKTREE_REPOS entry; keeping its repository row`
        );
        return;
      }

      // Guard 3 (the NOT EXISTS): a row with worktrees under it is not a ghost,
      // whatever the env says. This is the condition the issue names, and it is
      // what makes the delete provably lossless — nothing references the row.
      const result = db
        .prepare(
          `DELETE FROM repositories
            WHERE path = ?
              AND is_env_managed = 1
              AND NOT EXISTS (
                SELECT 1 FROM worktrees WHERE worktrees.repository_path = ?
              )`
        )
        .run(rootDir, rootDir);

      if (result.changes > 0) {
        console.log(`Migration 43: removed CM_ROOT_DIR ghost repository row (${rootDir})`);
      } else {
        console.log(`Migration 43: no ghost repository row at ${rootDir}`);
      }
    },
    down: () => {
      // The deleted row carried no user data — an env-managed ghost with no
      // worktrees, no clone URL, and default flags — and re-inserting it would
      // restore the very defect this migration fixes. No-op rollback (mirrors
      // v35/v40).
      console.log('No rollback for the CM_ROOT_DIR ghost row removal');
    },
  },
];
