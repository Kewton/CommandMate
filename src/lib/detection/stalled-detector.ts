/**
 * Stalled Detector - Determines if a worktree session is stalled.
 *
 * Issue #600: UX refresh - separated from worktree-status-helper.ts
 * to maintain SRP [DR1-010].
 *
 * Uses auto-yes-poller's lastServerResponseTimestamp and compares
 * against STALLED_THRESHOLD_MS to determine if a session is stalled.
 */

import { STALLED_THRESHOLD_MS } from '@/config/review-config';
import { getLastServerResponseTimestamp, buildCompositeKey } from '@/lib/polling/auto-yes-manager';
import type { CLIToolType } from '@/lib/cli-tools/types';

/**
 * Check if a worktree session is considered stalled.
 *
 * A session is stalled when:
 * - An auto-yes poller has been active (lastServerResponseTimestamp exists)
 * - The time since the last server response exceeds STALLED_THRESHOLD_MS
 *
 * If no timestamp exists (no auto-yes poller active), returns false.
 *
 * @param worktreeId - Worktree identifier
 * @param cliToolId - CLI tool type
 * @param now - Current timestamp in ms (defaults to Date.now(), injectable for testing)
 * @returns true if the session is considered stalled
 */
export function isWorktreeStalled(
  worktreeId: string,
  cliToolId: CLIToolType,
  now: number = Date.now()
): boolean {
  const compositeKey = buildCompositeKey(worktreeId, cliToolId);
  const lastTimestamp = getLastServerResponseTimestamp(compositeKey);

  if (lastTimestamp === null) {
    return false;
  }

  return (now - lastTimestamp) >= STALLED_THRESHOLD_MS;
}
