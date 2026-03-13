/**
 * tmux capture cache module
 * Issue #405: TTL-based cache for tmux capture-pane output with singleflight deduplication
 *
 * Provides in-memory caching of tmux capture-pane results to eliminate redundant
 * tmux process invocations. Uses globalThis pattern for Next.js hot reload persistence.
 *
 * Cache key: sessionName (mcbd-{cliToolId}-{worktreeId} format)
 * Cache value: CacheEntry (output + metadata)
 * TTL: 2 seconds (CACHE_TTL_MS)
 *
 * [SEC4-001] Trust Boundary: sessionName is validated by the caller chain
 * (CLIToolManager.getTool(cliToolId).getSessionName()). This module does not
 * perform additional sessionName validation.
 *
 * [DA3-002] Singleflight key uses sessionName, which contains cliToolId.
 * Different cliToolIds cannot share the same singleflight entry, preventing
 * error message context mismatch across callers.
 */

/** Cache entry structure */
import { createLogger } from '@/lib/logger';

const logger = createLogger('tmux-capture-cache');
interface CacheEntry {
  /** Captured output (stored at max capture lines) */
  output: string;
  /** Number of lines the output was captured with */
  capturedLines: number;
  /** Cache write timestamp (Date.now()) */
  timestamp: number;
}

// =========================================================================
// Constants
// =========================================================================

/** Cache TTL in milliseconds */
export const CACHE_TTL_MS = 2000;

/** Maximum number of cache entries */
export const CACHE_MAX_ENTRIES = 100;

/** Maximum capture lines for cache storage */
export const CACHE_MAX_CAPTURE_LINES = 10000;

// =========================================================================
// globalThis pattern (Next.js hot reload persistence)
// =========================================================================

declare global {
  // eslint-disable-next-line no-var
  var __tmuxCaptureCache: Map<string, CacheEntry> | undefined;
  // eslint-disable-next-line no-var
  var __tmuxCaptureCacheInflight: Map<string, Promise<string>> | undefined;
}

function getCache(): Map<string, CacheEntry> {
  return (globalThis.__tmuxCaptureCache ??= new Map<string, CacheEntry>());
}

function getInflight(): Map<string, Promise<string>> {
  return (globalThis.__tmuxCaptureCacheInflight ??= new Map<string, Promise<string>>());
}

// =========================================================================
// sliceOutput()
// =========================================================================

/**
 * Slice output from the end to return the last requestedLines lines.
 * If requestedLines >= total lines, returns the full output.
 *
 * @param fullOutput - Full captured output string
 * @param requestedLines - Number of lines requested from the end
 * @returns Sliced output string
 */
export function sliceOutput(fullOutput: string, requestedLines: number): string {
  if (fullOutput === '') return '';

  const lines = fullOutput.split('\n');
  if (requestedLines >= lines.length) return fullOutput;

  return lines.slice(-requestedLines).join('\n');
}

// =========================================================================
// getCachedCapture()
// =========================================================================

/**
 * Get cached capture output for a session.
 * Returns null on cache miss, TTL expiration, or insufficient cached lines.
 * Performs lazy eviction of TTL-expired entries.
 *
 * [SEC4-002] Lazy eviction only: expired entries that are never queried
 * may persist in memory. Full sweep is performed in setCachedCapture().
 *
 * @param sessionName - tmux session name (cache key)
 * @param requestedLines - Number of lines requested
 * @returns Cached output (sliced to requestedLines) or null
 */
export function getCachedCapture(
  sessionName: string,
  requestedLines: number
): string | null {
  const cache = getCache();
  const entry = cache.get(sessionName);

  if (!entry) return null;

  // TTL check with lazy eviction
  const now = Date.now();
  if (now - entry.timestamp > CACHE_TTL_MS) {
    cache.delete(sessionName);
    return null;
  }

  // Insufficient cached lines check
  if (requestedLines > entry.capturedLines) {
    return null;
  }

  return sliceOutput(entry.output, requestedLines);
}

// =========================================================================
// setCachedCapture()
// =========================================================================

/**
 * Store capture output in cache.
 * Performs full sweep of TTL-expired entries before writing (SEC4-002).
 * Enforces CACHE_MAX_ENTRIES limit by evicting oldest entry.
 *
 * @param sessionName - tmux session name (cache key)
 * @param output - Captured output string
 * @param capturedLines - Number of lines the output was captured with
 */
export function setCachedCapture(
  sessionName: string,
  output: string,
  capturedLines: number
): void {
  const cache = getCache();
  const now = Date.now();

  // [SEC4-002] Full sweep: remove all TTL-expired entries
  for (const [key, entry] of cache) {
    if (now - entry.timestamp > CACHE_TTL_MS) {
      cache.delete(key);
    }
  }

  // Enforce size limit (evict oldest if at capacity)
  if (cache.size >= CACHE_MAX_ENTRIES && !cache.has(sessionName)) {
    // Find and delete oldest entry
    let oldestKey: string | null = null;
    let oldestTimestamp = Infinity;
    for (const [key, entry] of cache) {
      if (entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
        oldestKey = key;
      }
    }
    if (oldestKey) {
      cache.delete(oldestKey);
    }
  }

  cache.set(sessionName, {
    output,
    capturedLines,
    timestamp: now,
  });
}

// =========================================================================
// invalidateCache()
// =========================================================================

/**
 * Invalidate cache for a specific session.
 * [SEC4-006] Logs debug message with session name for troubleshooting.
 *
 * @param sessionName - tmux session name to invalidate
 */
export function invalidateCache(sessionName: string): void {
  const cache = getCache();
  cache.delete(sessionName);

  // [SEC4-006] Debug log for cache invalidation chain tracking
  logger.debug('cache:invalidate', { sessionName });
}

// =========================================================================
// clearAllCache()
// =========================================================================

/**
 * Clear all cache entries and inflight requests.
 * Used for graceful shutdown.
 */
export function clearAllCache(): void {
  const cache = getCache();
  cache.clear();

  const inflight = getInflight();
  inflight.clear();
}

// =========================================================================
// resetCacheForTesting()
// =========================================================================

/**
 * Reset cache and inflight maps for test isolation.
 * @internal Exported for testing purposes only.
 */
export function resetCacheForTesting(): void {
  globalThis.__tmuxCaptureCache = undefined;
  globalThis.__tmuxCaptureCacheInflight = undefined;
}

// =========================================================================
// getOrFetchCapture() - singleflight pattern
// =========================================================================

/**
 * Get capture output from cache or fetch it.
 * Implements singleflight pattern: concurrent requests for the same session
 * share a single fetchFn invocation.
 *
 * [DA3-002] Singleflight key is sessionName which contains cliToolId,
 * preventing cross-cliTool error context mismatch.
 *
 * @param sessionName - tmux session name
 * @param requestedLines - Number of lines requested
 * @param fetchFn - Function to fetch output on cache miss
 * @returns Captured output (sliced to requestedLines)
 */
export async function getOrFetchCapture(
  sessionName: string,
  requestedLines: number,
  fetchFn: () => Promise<string>
): Promise<string> {
  // 1. Check cache first
  const cached = getCachedCapture(sessionName, requestedLines);
  if (cached !== null) {
    return cached;
  }

  // 2. Check for inflight request (singleflight)
  const inflight = getInflight();
  const existingPromise = inflight.get(sessionName);
  if (existingPromise) {
    const result = await existingPromise;
    return sliceOutput(result, requestedLines);
  }

  // 3. Create new fetch promise
  const fetchPromise = fetchFn();
  inflight.set(sessionName, fetchPromise);

  try {
    const output = await fetchPromise;

    // Cache non-empty results only [SEC4-007]
    if (output.length > 0) {
      setCachedCapture(sessionName, output, CACHE_MAX_CAPTURE_LINES);
    }

    return sliceOutput(output, requestedLines);
  } finally {
    // Clean up inflight entry
    inflight.delete(sessionName);
  }
}
