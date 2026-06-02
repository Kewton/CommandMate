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
import { MAX_GIT_FILES } from '@/config/git-status-config';

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
