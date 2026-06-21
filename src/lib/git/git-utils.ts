/**
 * Git utility functions — backward-compatible re-export barrel.
 * Issue #111: Branch visualization feature (original home of these utilities).
 * Issue #921: the 2327-line god-module was split by concern into the sibling
 * modules re-exported below. This file stays a barrel so the ~29 existing
 * `@/lib/git/git-utils` import sites (API routes + utilities + tests) keep
 * working unchanged (behavior-invariant, public API preserved).
 *
 * New code may import directly from the focused modules
 * (e.g. `@/lib/git/git-status`), but importing from here remains supported.
 *
 * Security considerations (unchanged, see each module):
 * - Uses execFile (not exec) to prevent command injection
 * - worktreePath must be from DB only (trusted source)
 * - Error details are logged server-side, not exposed to client
 */

export * from './git-errors';
export * from './git-exec';
export * from './git-default-branch';
export * from './git-status';
export * from './git-log';
export * from './git-diff';
export * from './git-commit';
export * from './git-branches';
export * from './git-stash';
export * from './git-reset';
export * from './git-remote';
