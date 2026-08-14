/**
 * The one derivation of "how many things need you right now" (Issue #1788).
 *
 * ## Read this first if you are #1789
 *
 * The tab title, the favicon dot and the App Badge in Issue #1789 must show the
 * *same* number the sidebar badge, the mobile nav badge and Home's Waiting stat
 * show. That is what this module is: the count lives here, and every surface
 * imports it rather than filtering the worktree list again. Use
 * {@link useAttentionCount} from a component, or {@link selectAttentionCount} /
 * {@link selectAttentionWorktrees} where you already hold the list (they are
 * pure and need no provider).
 *
 * ## The counting rule, stated on purpose
 *
 * **One waiting worktree counts once, however many of its agent instances are
 * waiting.** A worktree running claude and two codex aliases, all three sitting
 * on a permission dialog, is `1`, not `3`.
 *
 * That is not an arbitrary tie-break. The number is a link: it opens
 * {@link ATTENTION_REVIEW_HREF}, the Review screen's `approval` filter, whose
 * membership predicate is `(wt) => wt.isWaitingForResponse === true` — a list of
 * *worktrees*. A badge that counted instances would say 3 and open a list of 1,
 * and the user would be left looking for the two that are not there. Counting
 * worktrees keeps the badge and the list it opens the same fact.
 *
 * `isWaitingForResponse` at the worktree level is the server's aggregate (the
 * logical OR across every instance, see `worktree-status-helper`), so no
 * per-instance walk is needed here to get that OR right.
 *
 * @module hooks/useAttentionCount
 */

'use client';

import { useMemo } from 'react';
import { useOptionalWorktreesCacheContext } from '@/components/providers/WorktreesCacheProvider';
import type { Worktree } from '@/types/models';

export { ATTENTION_REVIEW_HREF } from '@/config/review-config';

/**
 * The worktrees needing a human right now, in the order they were given.
 *
 * Strict `=== true` rather than truthiness, matching `ReviewTab`'s `approval`
 * predicate exactly: the field is optional on {@link Worktree} and a payload
 * from an older server omits it entirely.
 */
export function selectAttentionWorktrees(worktrees: readonly Worktree[]): Worktree[] {
  return worktrees.filter((wt) => wt.isWaitingForResponse === true);
}

/** How many worktrees need a human right now. See the module docblock. */
export function selectAttentionCount(worktrees: readonly Worktree[]): number {
  let count = 0;
  for (const wt of worktrees) {
    if (wt.isWaitingForResponse === true) count++;
  }
  return count;
}

export interface UseAttentionCountReturn {
  /** Number of worktrees waiting for the user. `0` means "render nothing". */
  count: number;
  /** Those worktrees, for surfaces that name them (e.g. a tooltip). */
  worktrees: Worktree[];
}

/**
 * Subscribe to the attention count from the shared worktrees cache.
 *
 * Reads the *optional* cache context (Issue #709's single-poller guarantee):
 * calling `useWorktreesCache()` here would spawn a second `/api/worktrees`
 * poller, and throwing outside the provider would make the badge impossible to
 * mount in an isolated test or a page that has no cache. With no provider above
 * it, the count is `0` and every badge simply does not render.
 */
export function useAttentionCount(): UseAttentionCountReturn {
  const cache = useOptionalWorktreesCacheContext();
  const worktrees = cache?.worktrees;

  return useMemo(() => {
    const attention = worktrees ? selectAttentionWorktrees(worktrees) : [];
    return { count: attention.length, worktrees: attention };
  }, [worktrees]);
}
