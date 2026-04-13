/**
 * Memo Configuration Constants
 *
 * Issue #652: Increase memo limit from 5 to 10.
 *
 * Shared constants used across:
 * - API route: src/app/api/worktrees/[id]/memos/route.ts (POST validation)
 * - Client component: src/components/worktree/MemoPane.tsx (UI display control)
 */

/** Maximum number of memos allowed per worktree */
export const MAX_MEMOS = 10;
