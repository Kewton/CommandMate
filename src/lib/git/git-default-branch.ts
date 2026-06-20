/**
 * Repository default-branch resolution (origin/HEAD).
 * Issue #921: extracted from git-utils.ts (god-module split, P1-a).
 *
 * Shared by reset / deleteBranch / push protection (Issue #783, DR1-001).
 */

import { execGitCommand } from './git-exec';

/**
 * Sentinel returned by getDefaultBranch when origin/HEAD is UNRESOLVED (the
 * `symbolic-ref` read returned null). DISTINCT from `null` (which means
 * symbolic-ref resolved to a value that is NOT an `origin/` ref). Issue #783,
 * DR1-002: callers must distinguish "unresolved" from "resolved-but-non-origin/"
 * so the reset fallback only fires on TRUE unresolution.
 */
export const DEFAULT_BRANCH_UNRESOLVED = Symbol('default-branch-unresolved');

/**
 * Resolve the repository default branch name via origin/HEAD (Issue #783,
 * shared by reset / deleteBranch / push protection — DR1-001).
 *
 * Returns THREE distinguishable outcomes (DR1-002 — required for reset's
 * byte-invariance):
 *   - string                    : origin/<name> resolved; returns <name> (e.g. "main")
 *   - DEFAULT_BRANCH_UNRESOLVED : symbolic-ref returned null (origin/HEAD unresolved)
 *   - null                      : symbolic-ref returned a value that is NOT an
 *                                 `origin/` ref (unexpected value)
 *
 * Keeping "unresolved" and "resolved-but-non-origin/" separate lets
 * isDefaultBranchForReset's main/master fallback fire ONLY when truly unresolved,
 * preserving the original behavior (a naive `startsWith ? slice : null` would
 * collapse the non-origin/ case into null and wrongly trigger the fallback).
 */
export async function getDefaultBranch(
  worktreePath: string
): Promise<string | null | typeof DEFAULT_BRANCH_UNRESOLVED> {
  // DR2-006: execGitCommand returns an already-trimmed string on success / null
  // on failure, so out is trimmed; the out.trim() below is an idempotent (harmless)
  // double-trim. The "trimmed string / null" pair maps cleanly onto the 3 values:
  //   UNRESOLVED (out===null) / resolved name (startsWith 'origin/') / non-origin/ (else -> null).
  // Empty-string edge: if symbolic-ref returned '' (non-null), v='' -> startsWith
  // false -> null, matching the original isDefaultBranchForReset behavior.
  const out = await execGitCommand(
    ['symbolic-ref', 'refs/remotes/origin/HEAD', '--short'],
    worktreePath
  );
  if (out === null) return DEFAULT_BRANCH_UNRESOLVED;
  const v = out.trim();
  return v.startsWith('origin/') ? v.slice('origin/'.length) : null;
}

/**
 * Thin wrapper for callers that only want "the resolved default name, or null
 * when unknown" (Issue #783, DR1-001). Collapses both DEFAULT_BRANCH_UNRESOLVED
 * and the non-origin/ `null` into `null` (= default name unknown). Used by
 * deleteBranch (no fallback) and push protection (null = unprotected).
 */
export async function resolveDefaultBranchName(worktreePath: string): Promise<string | null> {
  const r = await getDefaultBranch(worktreePath);
  return typeof r === 'string' ? r : null;
}
