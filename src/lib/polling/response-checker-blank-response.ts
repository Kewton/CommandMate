/**
 * The blank-response skips of `checkForResponse` (Issue #3784 split from
 * response-checker.ts).
 */

import type Database from 'better-sqlite3';
import { updateSessionState } from '@/lib/db';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { resetDuplicateResponseSkipStreak } from './response-dedup';

/** True when the extracted response has no content. */
export function isBlankExtractedResponse(response: string): boolean {
  return !response || response.trim() === '';
}

/** True when the cleaned response is empty or just "[No content]". */
export function isBlankCleanedResponse(cleanedResponse: string): boolean {
  return !cleanedResponse || cleanedResponse.trim() === '' || cleanedResponse === '[No content]';
}

/**
 * What a blank response leaves behind: the run of duplicate response ticks is
 * over and the cursor moves to this capture. Written only by a tick that still
 * owns the poller.
 */
export function recordBlankResponseSkip(
  db: Database.Database,
  worktreeId: string,
  cliToolId: CLIToolType,
  resolvedInstanceId: string,
  pollerKey: string,
  lineCount: number,
  owns: boolean
): void {
  if (owns) {
    resetDuplicateResponseSkipStreak(pollerKey);
    updateSessionState(db, worktreeId, cliToolId, lineCount, resolvedInstanceId);
  }
}
