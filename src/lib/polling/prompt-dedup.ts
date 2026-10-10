/**
 * Prompt deduplication module (SRP: single responsibility)
 * Issue #565: Prevents duplicate prompt messages for TUI-based CLI tools
 *
 * Uses SHA-256 content hash with an in-memory cache (Map<pollerKey, hash>).
 * Design decision [DR1-006]: In-memory only (no DB layer).
 * Process restart may cause a single duplicate, which is acceptable (KISS).
 *
 * ## How often the skip says so (Issue #3538)
 *
 * A full-screen TUI (copilot, opencode) keeps polling while it sits on a
 * prompt, so the same prompt is a duplicate on every 2 s tick until it is
 * answered, and `duplicate-prompt-skipped` used to be logged on each of them.
 * The run of duplicate ticks is counted here, the same way `response-dedup`
 * counts `duplicate-response-skipped` (#3519): the line is written on the first
 * tick of a run and then once per {@link DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL}
 * ticks. The count is about one particular cached hash, so it lives and dies
 * with it — the functions below that drop or move the hash drop or move the
 * count too, and nothing else touches it.
 *
 * Only the log line is thinned. `recordPromptDedupSkip` (#1695) is still called
 * on every duplicate tick; its tally is what `capture --json` reports.
 */

import { createHash } from 'crypto';
import type { CLIToolType } from '@/lib/cli-tools/types';
import { getOrInitGlobal } from '../global-state';
import { DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL } from './response-dedup';

/**
 * In-memory cache: pollerKey -> SHA-256 hash of last saved prompt content.
 *
 * On `globalThis` because it shares the response poller's lifecycle (Issue
 * #2223): written by `checkForResponse` inside the poller tick, cleared by
 * `stopPolling`/`session-cleanup`, re-keyed by
 * `migrateResponsePollerWorktreeIds`. Those callers do not all live in the same
 * module graph — `next start` evaluates the poller once per route bundle and
 * once in the custom server — so a module-scope map let a stop clear the
 * *caller's* copy while the entry the timer owner is deduplicating against
 * stayed behind, and a rename move a hash the poller never reads.
 */
declare global {
  // eslint-disable-next-line no-var
  var __promptHashCache: Map<string, string> | undefined;
  // eslint-disable-next-line no-var
  var __duplicatePromptSkipStreak: Map<string, number> | undefined;
}

const promptHashCache = getOrInitGlobal('__promptHashCache', () => new Map<string, string>());

/**
 * In-memory cache: pollerKey -> how many duplicate ticks in a row the current
 * cached prompt hash has been skipped (Issue #3538). Absence means none yet.
 *
 * On `globalThis` for the same reason `promptHashCache` is, and cleared and
 * moved at exactly the same moments — see the module comment.
 */
const duplicatePromptSkipStreak = getOrInitGlobal('__duplicatePromptSkipStreak', () => new Map<string, number>());

/**
 * How many duplicate ticks separate two `duplicate-prompt-skipped` lines
 * (Issue #3538). Shared with `duplicate-response-skipped` (#3519): one line a
 * minute at the poller's 2 s tick.
 */
export const DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL = DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL;

/** What {@link claimDuplicatePromptSkipLog} answers for one duplicate tick. */
export interface DuplicatePromptSkipLogClaim {
  /** true when this tick should write `duplicate-prompt-skipped` */
  log: boolean;
  /** 1-based position of this tick in the current run of duplicate ticks */
  consecutive: number;
  /** ticks skipped without a log line since the previous logged one */
  suppressed: number;
}

/**
 * Check if the given prompt content is a duplicate of the last saved prompt
 * for the same pollerKey. If not a duplicate, updates the cache.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 * @param content - Prompt content to check
 * @returns true if this is a duplicate (same content as last saved), false otherwise
 */
export function isDuplicatePrompt(pollerKey: string, content: string): boolean {
  const hash = createHash('sha256').update(content).digest('hex');

  if (promptHashCache.get(pollerKey) === hash) {
    return true;
  }

  promptHashCache.set(pollerKey, hash);
  // Issue #3538: a new prompt starts a new run of duplicate ticks.
  duplicatePromptSkipStreak.delete(pollerKey);
  return false;
}

/**
 * Count one duplicate prompt tick for this pollerKey and say whether it should
 * be logged (Issue #3538).
 *
 * A claim: it advances the count, so call it exactly once per duplicate tick.
 * Logs on the first tick of a run and then on every
 * {@link DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL}th tick after it (ticks 1,
 * 1+N, 1+2N, …).
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 * @returns Whether to log, the run length so far, and the ticks left unlogged
 *   since the previous line
 */
export function claimDuplicatePromptSkipLog(pollerKey: string): DuplicatePromptSkipLogClaim {
  const consecutive = (duplicatePromptSkipStreak.get(pollerKey) ?? 0) + 1;
  duplicatePromptSkipStreak.set(pollerKey, consecutive);

  const log = (consecutive - 1) % DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL === 0;
  const suppressed = consecutive === 1 ? 0 : DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL - 1;
  return { log, consecutive, suppressed };
}

/**
 * Clear the prompt hash cache for a specific pollerKey.
 * Called during session cleanup / stopPolling.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 */
export function clearPromptHashCache(pollerKey: string): void {
  promptHashCache.delete(pollerKey);
  // Issue #3538: the skip count is about the same hash.
  duplicatePromptSkipStreak.delete(pollerKey);
}

/**
 * Move the cached hash from one pollerKey to another.
 *
 * Used when a worktree ID is renamed underneath a running poller
 * (Issue #1621 Phase 3). Clearing instead of moving would let the poller
 * re-save the prompt it is currently sitting on as a fresh message, which is
 * the duplicate this module exists to prevent.
 *
 * No-op when nothing is cached under `oldKey`.
 *
 * @param oldKey - Poller key the cache entry lives under
 * @param newKey - Poller key it should live under
 */
export function renamePromptHashCacheKey(oldKey: string, newKey: string): void {
  if (oldKey === newKey) return;
  const hash = promptHashCache.get(oldKey);
  promptHashCache.delete(oldKey);
  if (hash !== undefined) promptHashCache.set(newKey, hash);

  // Issue #3538: the skip count moves with the hash, so a rename mid-run does
  // not restart the thinning and log as if a new run had begun.
  const streak = duplicatePromptSkipStreak.get(oldKey);
  duplicatePromptSkipStreak.delete(oldKey);
  if (streak !== undefined) duplicatePromptSkipStreak.set(newKey, streak);
}

/**
 * Normalize prompt content before deduplication check.
 * For Copilot, replaces cursor position markers at line beginnings
 * with spaces, so that prompts differing only in cursor position
 * are treated as duplicates.
 *
 * For non-Copilot tools, returns content unchanged to avoid
 * affecting their deduplication logic.
 *
 * Issue #571: Moved from response-poller.ts in Issue #575 module split.
 *
 * @param content - Raw prompt content
 * @param cliToolId - CLI tool identifier
 * @returns Normalized content for deduplication comparison
 */
export function normalizePromptForDedup(content: string, cliToolId: CLIToolType): string {
  if (cliToolId !== 'copilot') {
    return content;
  }
  // Replace cursor position markers at line start with equivalent spaces
  return content.replace(/^[❯>]\s/gm, '  ');
}
