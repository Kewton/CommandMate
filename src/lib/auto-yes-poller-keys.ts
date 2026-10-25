/**
 * Auto-Yes poller: which composite keys have a poller entry (Issue #525)
 * (Issue #3893: split out of `auto-yes-poller.ts`, which re-exports these).
 *
 * Reads `autoYesPollerStates`, owned by `polling/auto-yes-poller-generation`.
 * Does not import `auto-yes-poller.ts` (no cycle).
 *
 * @module lib/auto-yes-poller-keys
 */

import { filterCompositeKeysByWorktree } from './auto-yes-state';
import { autoYesPollerStates } from './polling/auto-yes-poller-generation';

/**
 * Get all composite keys that have active auto-yes poller entries.
 *
 * Issue #525: Returns composite keys (worktreeId:cliToolId).
 *
 * @returns Array of composite keys present in the autoYesPollerStates Map
 */
export function getAutoYesPollerCompositeKeys(): string[] {
  return Array.from(autoYesPollerStates.keys());
}

/**
 * Check if any auto-yes poller is active for a given worktreeId.
 * Uses shared filterCompositeKeysByWorktree (DRY).
 *
 * @param worktreeId - Worktree identifier
 * @returns true if any poller is active for this worktree
 */
export function isAnyPollerActiveForWorktree(worktreeId: string): boolean {
  return filterCompositeKeysByWorktree(
    Array.from(autoYesPollerStates.keys()),
    worktreeId
  ).length > 0;
}
