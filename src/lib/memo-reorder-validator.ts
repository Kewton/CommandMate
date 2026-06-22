/**
 * Memo reorder validator (Issue #944)
 *
 * `reorderMemos` performs no validation (callers are responsible), so the
 * PATCH /api/worktrees/:id/memos route delegates domain checks to this pure,
 * unit-testable helper. It lives outside the route module because Next.js route
 * files may only export HTTP method handlers (and select config fields).
 */

import type { WorktreeMemo } from '@/types/models';

/**
 * Validate a memo reorder payload against the worktree's existing memos.
 *
 * The request must contain exactly the same set of memo IDs as the worktree
 * already owns — just reordered. This rejects non-array input, non-string
 * elements, count mismatches, duplicates, and any ID that does not belong to
 * the worktree (other-worktree / nonexistent IDs).
 *
 * @param memoIds - The reordered IDs from the request body (untrusted)
 * @param existingMemos - The worktree's current memos (source of truth)
 * @returns `{ valid: true }` or `{ valid: false, error }`
 */
export function validateMemoReorderInput(
  memoIds: unknown,
  existingMemos: WorktreeMemo[]
): { valid: boolean; error?: string } {
  if (!Array.isArray(memoIds)) {
    return { valid: false, error: 'memoIds must be an array' };
  }

  if (!memoIds.every((id) => typeof id === 'string')) {
    return { valid: false, error: 'memoIds must contain only strings' };
  }

  if (memoIds.length !== existingMemos.length) {
    return {
      valid: false,
      error: `memoIds count (${memoIds.length}) must match existing memo count (${existingMemos.length})`,
    };
  }

  if (new Set(memoIds).size !== memoIds.length) {
    return { valid: false, error: 'memoIds must not contain duplicates' };
  }

  const existingIds = new Set(existingMemos.map((m) => m.id));
  if (!memoIds.every((id) => existingIds.has(id))) {
    return {
      valid: false,
      error: "memoIds must match the worktree's existing memo IDs",
    };
  }

  return { valid: true };
}
