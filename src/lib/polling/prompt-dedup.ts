/**
 * Prompt deduplication module (SRP: single responsibility)
 * Issue #565: Prevents duplicate prompt messages for TUI-based CLI tools
 *
 * Uses SHA-256 content hash with an in-memory cache (Map<pollerKey, hash>).
 * Design decision [DR1-006]: In-memory only (no DB layer).
 * Process restart may cause a single duplicate, which is acceptable (KISS).
 */

import { createHash } from 'crypto';

/**
 * In-memory cache: pollerKey -> SHA-256 hash of last saved prompt content.
 */
const promptHashCache = new Map<string, string>();

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
  return false;
}

/**
 * Clear the prompt hash cache for a specific pollerKey.
 * Called during session cleanup / stopPolling.
 *
 * @param pollerKey - Poller key ("worktreeId:cliToolId")
 */
export function clearPromptHashCache(pollerKey: string): void {
  promptHashCache.delete(pollerKey);
}
