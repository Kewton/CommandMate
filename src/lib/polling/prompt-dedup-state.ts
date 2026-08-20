/**
 * In-memory tally of prompts the content-hash dedup guard declined to save
 * (Issue #1695).
 *
 * `isDuplicatePrompt` (see `prompt-dedup.ts`, Issue #565) drops a detected
 * prompt without writing anything to the database, and until now the only trace
 * it left was `logger.info('duplicate-prompt-skipped', …)` in the server log.
 * From `commandmate capture --json` the outcome is indistinguishable from the
 * detection layer never having classified the frame at all (Issue #1676): both
 * answer "no prompt was recorded". This module keeps the skip count and the
 * last skip time per session so `buildCurrentOutput` can publish them and an
 * operator can tell "the guard suppressed it" from "nothing saw it".
 *
 * Exposure only: nothing reads this to make a decision. The guard itself keeps
 * its own hash cache and is untouched by whether anyone reads the tally.
 *
 * **Cumulative, not per-turn.** The hash cache behind the guard is cleared by
 * `stopPolling()` at the end of every polling cycle; the tally deliberately is
 * not, because the question it answers ("has this session been dropping
 * prompts, and how recently?") spans turns. `lastSkippedAt` is what dates the
 * evidence — a large `skippedCount` with an hours-old `lastSkippedAt` is
 * history, the same count with a fresh one is happening right now.
 *
 * Keyed like `auto-yes-suppression-state` (worktreeId / cliToolId / instanceId
 * via `buildCompositeKey`) so the reader in `current-output-builder` can look it
 * up with the identifiers the request already carries, rather than with the
 * poller key, whose builder lives behind `response-poller-core`'s import graph.
 *
 * In-memory and not in SQLite for the same reason the suppression record is:
 * it describes a live tmux session, and a session does not survive a server
 * restart for the record to still be about.
 *
 * @module lib/polling/prompt-dedup-state
 */

import { buildCompositeKey } from '@/lib/auto-yes-state';
import type { CLIToolType } from '@/lib/cli-tools/types';

/** How often the dedup guard suppressed a prompt for one session, and when last. */
export interface PromptDedupSkips {
  /** Prompts dropped by `isDuplicatePrompt` since the server started. */
  skippedCount: number;
  /** Epoch ms of the most recent skip, or null when there has been none. */
  lastSkippedAt: number | null;
}

/**
 * Reached through `globalThis` for the same reason `auto-yes-suppression-state`
 * is (Issue #1736): the writer (`response-checker`, running inside the poller)
 * and the reader (`buildCurrentOutput`, running inside a route handler) are
 * bundled separately under `next dev` and would otherwise each hold their own
 * copy of this map — leaving `capture --json` reporting zero skips for a session
 * that is actively dropping prompts, which is exactly the blindness this module
 * exists to remove.
 */
declare global {
  // eslint-disable-next-line no-var
  var __promptDedupSkips: Map<string, PromptDedupSkips> | undefined;
}

/** compositeKey -> running tally of suppressed prompts for that session. */
const promptDedupSkips = globalThis.__promptDedupSkips ??
  (globalThis.__promptDedupSkips = new Map<string, PromptDedupSkips>());

/**
 * Count one prompt the dedup guard suppressed for `instanceId`.
 *
 * @param at - Epoch ms; defaults to now. Overridable so tests are deterministic.
 */
export function recordPromptDedupSkip(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId: string | undefined,
  at: number = Date.now()
): void {
  const key = buildCompositeKey(worktreeId, cliToolId, instanceId);
  const previous = promptDedupSkips.get(key);
  promptDedupSkips.set(key, {
    skippedCount: (previous?.skippedCount ?? 0) + 1,
    lastSkippedAt: at,
  });
}

/**
 * @returns The tally for this session. Never null: a session the guard has
 *   never fired for reports `{ skippedCount: 0, lastSkippedAt: null }`, so
 *   `capture --json` prints an explicit "no prompt was suppressed" rather than
 *   an absent key a consumer has to guess about.
 */
export function getPromptDedupSkips(
  worktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): PromptDedupSkips {
  return (
    promptDedupSkips.get(buildCompositeKey(worktreeId, cliToolId, instanceId)) ?? {
      skippedCount: 0,
      lastSkippedAt: null,
    }
  );
}

/**
 * Carry the tally across a worktree-ID rename (Issue #1621 Phase 3).
 *
 * The dedup hash caches are deliberately moved rather than dropped by
 * `migrateResponsePollerWorktreeIds`, so the guard goes on suppressing the
 * prompt currently on screen under the new ID. A tally left behind would then
 * report zero skips for a session that is still skipping — the false negative
 * this module exists to prevent, appearing at exactly the moment the record
 * matters.
 *
 * No-op when the IDs match or nothing is recorded under the old one.
 */
export function renamePromptDedupSkips(
  oldWorktreeId: string,
  newWorktreeId: string,
  cliToolId: CLIToolType,
  instanceId?: string
): void {
  if (oldWorktreeId === newWorktreeId) return;
  const oldKey = buildCompositeKey(oldWorktreeId, cliToolId, instanceId);
  const record = promptDedupSkips.get(oldKey);
  promptDedupSkips.delete(oldKey);
  if (record !== undefined) {
    promptDedupSkips.set(buildCompositeKey(newWorktreeId, cliToolId, instanceId), record);
  }
}

/** Drop every recorded tally. Test seam. */
export function clearPromptDedupSkips(): void {
  promptDedupSkips.clear();
}
