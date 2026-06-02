/**
 * Shared worktree-resolution helper for git API routes (Issue #781).
 *
 * Collapses the `isValidWorktreeId -> getDbInstance -> getWorktreeById -> 404`
 * boilerplate that every git route repeats verbatim. Returns either the resolved
 * Worktree or a ready-to-return NextResponse (400 invalid id / 404 not found),
 * with byte-identical error bodies to the inlined versions so client-visible
 * behavior is unchanged.
 *
 * Kept in its own module (NOT git-route-helpers.ts, which is deliberately
 * db-free so its validator survives `vi.mock('@/lib/git/git-utils')` and pulls
 * in no SQLite). The route unit tests mock `@/lib/db`, `@/lib/db/db-instance`,
 * and `@/lib/security/path-validator`; vitest hoists those module mocks globally,
 * so this helper transparently resolves to the mocked implementations.
 */

import { NextResponse } from 'next/server';
import { getDbInstance } from '@/lib/db/db-instance';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import type { Worktree } from '@/types/models';

/**
 * Validate the route `id` and resolve its Worktree.
 *
 * @param id - The `params.id` route segment
 * @returns The Worktree on success, or a 400 (invalid id format) / 404 (not
 *          found) NextResponse to return directly.
 */
export function resolveWorktreeOr404(id: string): Worktree | NextResponse {
  if (!isValidWorktreeId(id)) {
    return NextResponse.json(
      { error: 'Invalid worktree ID format' },
      { status: 400 }
    );
  }

  const db = getDbInstance();
  const worktree = getWorktreeById(db, id);

  if (!worktree) {
    return NextResponse.json(
      { error: 'Worktree not found' },
      { status: 404 }
    );
  }

  return worktree;
}
