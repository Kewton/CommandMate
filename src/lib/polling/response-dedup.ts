/**
 * Assistant response deduplication module (SRP: single responsibility)
 * Issue #1268: Prevents duplicate assistant messages for alternate-screen CLI tools
 *
 * Mirrors prompt-dedup.ts (Issue #565), but for normal (non-prompt) responses.
 *
 * Why this exists: tools that render in the terminal's alternate screen
 * (see `usesAlternateScreen`) have no scrollback, so the poller cannot use the
 * captured line count to tell "already saved" from "new". Without a line-count
 * cursor the poller would re-save the same finished screen on every tick, so
 * dedup has to be content-based instead.
 *
 * Design decision: in-memory only (no DB layer), keyed by pollerKey, and
 * cleared by stopPolling() — i.e. the cache lives exactly as long as one
 * polling cycle (one user turn). It answers "did I already save this screen
 * during THIS turn?" and deliberately does NOT persist across turns: an
 * identical response in a later turn is a real response and must be saved.
 * Suppressing it would reproduce the very bug this module fixes.
 */

import { createHash } from 'crypto';

/**
 * In-memory cache: pollerKey -> SHA-256 hash of the last saved response content.
 */
const responseHashCache = new Map<string, string>();

/**
 * Check whether the given response content was already saved during the current
 * polling cycle for the same pollerKey. If it is new, updates the cache.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 * @param content - Cleaned response content to check
 * @returns true if this is a duplicate (same content already saved this cycle)
 */
export function isDuplicateResponse(pollerKey: string, content: string): boolean {
  const hash = createHash('sha256').update(content).digest('hex');

  if (responseHashCache.get(pollerKey) === hash) {
    return true;
  }

  responseHashCache.set(pollerKey, hash);
  return false;
}

/**
 * Clear the response hash cache for a specific pollerKey.
 * Called during session cleanup / stopPolling, so each new user turn starts
 * with a clean slate.
 *
 * @param pollerKey - Poller key ("worktreeId:instanceId")
 */
export function clearResponseHashCache(pollerKey: string): void {
  responseHashCache.delete(pollerKey);
}
