/**
 * Shared helpers for git write API routes (Issue #780).
 *
 * Kept deliberately separate from git-utils.ts: the stage/unstage route unit
 * tests fully `vi.mock('@/lib/git/git-utils')`, so a validator living there
 * would be shadowed by the mock. This module is NOT mocked by those tests, so
 * the real validation runs against the (mocked) isPathSafe / real MAX_GIT_FILES.
 */

import { NextResponse } from 'next/server';
import { isPathSafe } from '@/lib/security/path-validator';
import { MAX_GIT_FILES, MAX_STASH_INDEX } from '@/config/git-status-config';

/**
 * Validate the `files` body field shared by the stage and unstage routes.
 *
 * Each entry must be a non-empty string and pass isPathSafe against the worktree
 * root (directory-traversal defense). The array must be non-empty and within
 * MAX_GIT_FILES. The 400 error wording mirrors the original per-route validators
 * verbatim so client-visible behavior is unchanged.
 *
 * @param files - Raw `files` value from the parsed request body
 * @param worktreePath - Worktree root used as the isPathSafe boundary
 * @returns The validated string[] on success, or a 400 NextResponse on failure
 */
export function validateFilesBody(
  files: unknown,
  worktreePath: string
): string[] | NextResponse {
  if (!Array.isArray(files) || files.length === 0) {
    return NextResponse.json(
      { error: 'files must be a non-empty array' },
      { status: 400 }
    );
  }
  if (files.length > MAX_GIT_FILES) {
    return NextResponse.json(
      { error: `files exceeds the maximum of ${MAX_GIT_FILES}` },
      { status: 400 }
    );
  }
  for (const file of files) {
    if (typeof file !== 'string' || file.length === 0) {
      return NextResponse.json(
        { error: 'files must contain only non-empty strings' },
        { status: 400 }
      );
    }
    if (!isPathSafe(file, worktreePath)) {
      return NextResponse.json(
        { error: 'Invalid file path' },
        { status: 400 }
      );
    }
  }
  return files as string[];
}

// ============================================================================
// Issue #781: branch-name validation (checkout / create / delete routes)
// ============================================================================

/** Maximum allowed branch-name length (DoS bound, matches git's practical cap). */
const MAX_BRANCH_REF_LENGTH = 255;

/**
 * Characters/sequences that `git check-ref-format` forbids in a ref component,
 * which we reject here without spawning a child process:
 * - whitespace and ASCII control characters (\x00-\x20 plus DEL \x7F)
 * - the special ref chars `~ ^ : ? * [ \`
 *
 * NOTE: `.` is deliberately ALLOWED (so `release/1.2` passes); only the dotted
 * SEQUENCES `..` / leading `.` / trailing `.` / trailing `.lock` are rejected
 * (handled separately below). This is the key behavioral divergence from the CLI
 * `validateBranchName` (BRANCH_NAME_PATTERN), which both rejects `.` and ALLOWS a
 * leading `-` (option-injection prone). See S3-003.
 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_BRANCH_CHARS = /[\x00-\x20\x7F~^:?*[\\]/;

/**
 * Validate a git branch name for the checkout / create / delete routes
 * (Issue #781). Distinct from the CLI `validateBranchName` (S3-003): it rejects a
 * leading `-` (option injection) and ALLOWS a `.` inside the name (`release/1.2`).
 *
 * Implements a regex-internal subset of `git check-ref-format` — no child
 * process. Even with this validation, every git command still terminates branch
 * args with `--` as defense in depth.
 *
 * @param name - Raw `branch` / `name` value from the parsed request body
 * @returns The validated string on success, or a 400 NextResponse on failure
 *          (`{ error, reason: 'invalid_branch_name' }`, mirroring validateFilesBody).
 */
export function validateGitBranchName(name: unknown): string | NextResponse {
  const invalid = (): NextResponse =>
    NextResponse.json(
      { error: 'Invalid branch name', reason: 'invalid_branch_name' },
      { status: 400 }
    );

  if (typeof name !== 'string' || name.length === 0) {
    return invalid();
  }
  if (name.length > MAX_BRANCH_REF_LENGTH) {
    return invalid();
  }
  // Leading `-` would be parsed as a git option (and the CLI validator lets it
  // through). Reject it outright in addition to the `--` terminator.
  if (name.startsWith('-')) {
    return invalid();
  }
  // Leading/trailing slash and consecutive slashes.
  if (name.startsWith('/') || name.endsWith('/') || name.includes('//')) {
    return invalid();
  }
  // Dotted sequences forbidden by check-ref-format (but a plain `.` is allowed).
  if (
    name.includes('..') ||
    name.startsWith('.') ||
    name.endsWith('.') ||
    name.endsWith('.lock')
  ) {
    return invalid();
  }
  // The `@{` reflog sequence is forbidden.
  if (name.includes('@{')) {
    return invalid();
  }
  // Special ref chars, whitespace, control chars.
  if (FORBIDDEN_BRANCH_CHARS.test(name)) {
    return invalid();
  }
  return name;
}

// ============================================================================
// Issue #782: stash index validation (pop / apply / drop routes)
// ============================================================================

/** A `stash@{N}` index must be a run of decimal digits only (no sign / decimal). */
const STASH_INDEX_PATTERN = /^\d+$/;

/**
 * Validate the stash `index` shared by the pop / apply / drop routes (Issue
 * #782). Accepts a non-negative integer (as a `number` from a JSON body, or a
 * `string` from the `[index]` dynamic route segment), bounded by MAX_STASH_INDEX.
 *
 * The validated value is returned as a `number`, so the caller can embed it into
 * `stash@{N}` with no possibility of argument injection (the value is purely
 * numeric). Mirrors validateFilesBody (#780) / validateGitBranchName (#781):
 * returns the value on success, or a 400 NextResponse
 * (`{ error, reason: 'invalid_stash_index' }`) on failure.
 *
 * @param index - Raw `index` value (number from a body, or string from a segment)
 * @returns The validated non-negative integer, or a 400 NextResponse
 */
export function validateStashIndex(index: unknown): number | NextResponse {
  const invalid = (): NextResponse =>
    NextResponse.json(
      { error: 'Invalid stash index', reason: 'invalid_stash_index' },
      { status: 400 }
    );

  let n: number;
  if (typeof index === 'number') {
    if (!Number.isInteger(index)) return invalid();
    n = index;
  } else if (typeof index === 'string') {
    // Strict digits-only (rejects '', ' 1', '+1', '1.5', 'abc').
    if (!STASH_INDEX_PATTERN.test(index)) return invalid();
    n = parseInt(index, 10);
  } else {
    return invalid();
  }

  if (n < 0 || n > MAX_STASH_INDEX) {
    return invalid();
  }
  return n;
}
