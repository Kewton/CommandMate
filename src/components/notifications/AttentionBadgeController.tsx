/**
 * Mount point for the out-of-page attention badges (Issue #1789).
 *
 * Renders nothing; it exists so {@link useAttentionBadge} runs exactly once, and
 * runs *inside* `WorktreesCacheProvider` — the hook reads the shared worktree
 * cache, and calling it from `AppProviders` itself would place it above that
 * provider, where the count is permanently 0 and the whole feature silently does
 * nothing.
 *
 * @module components/notifications/AttentionBadgeController
 */

'use client';

import { useAttentionBadge } from '@/hooks/useAttentionBadge';

export function AttentionBadgeController() {
  useAttentionBadge();
  return null;
}
