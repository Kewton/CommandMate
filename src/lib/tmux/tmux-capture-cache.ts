/**
 * tmux capture cache module
 * Issue #405: TTL-based cache for tmux capture-pane output with singleflight deduplication
 *
 * Provides in-memory caching of tmux capture-pane results to eliminate redundant
 * tmux process invocations. Uses globalThis pattern for Next.js hot reload persistence.
 *
 * Cache key: sessionName (mcbd-{cliToolId}-{worktreeId} format)
 * Cache value: CacheEntry (output + metadata)
 * TTL: 5 seconds (CACHE_TTL_MS)
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
import { getOrInitGlobal } from '../global-state';

const logger = createLogger('tmux-capture-cache');
interface CacheEntry {
  /** Captured output (stored at max capture lines) */
  output: string;
  /** Number of lines the output was captured with */
  capturedLines: number;
  /** Cache write timestamp (Date.now()) */
  timestamp: number;
  /**
   * Issue #3798: when the capture this entry holds was started — what a reader
   * served from the cache, or joined to the in-flight fetch, actually saw the
   * pane at (at the latest). The waiting episodes compare it with the time an
   * episode closed: a frame fetched before the close cannot reopen it.
   */
  fetchStartedAt: number;
}

// =========================================================================
// Constants
// =========================================================================

/**
 * Cache TTL in milliseconds.
 * Issue #499 Item 6: extended from 2000 to 3000 for improved cache hit rate.
 * Issue #965: extended from 3000 to 5000 to further cut redundant tmux
 * capture-pane invocations during sidebar→detail status probes. Kept modest to
 * preserve real-time responsiveness of the terminal/status UI.
 */
export const CACHE_TTL_MS = 5000;

/** Maximum number of cache entries */
export const CACHE_MAX_ENTRIES = 100;

/** Maximum capture lines for cache storage */
export const CACHE_MAX_CAPTURE_LINES = 10000;

// =========================================================================
// isCaptureWindowSaturated()
// =========================================================================

/**
 * Whether a capture came back clipped by the capture window (Issue #1670).
 *
 * Every capture in this app is a SLIDING WINDOW over the tail of the pane, not a
 * view of the whole buffer: `captureSessionOutput()` asks tmux for
 * `-S -CACHE_MAX_CAPTURE_LINES` and `sliceOutput()` then keeps only the last
 * `requestedLines` rows. So the returned line count is
 * `min(pane_scrollback + pane_height, windowLines)`.
 *
 * While the pane holds fewer rows than the window, that count GROWS with the
 * transcript, which is what makes `session_states.last_captured_line` usable as a
 * "how far have I read" cursor. Once the pane outgrows the window the count is
 * pinned at `windowLines` forever and the window merely slides: a line index
 * recorded earlier no longer denotes the same line, and no later capture can ever
 * report a larger count. Callers must stop trusting the cursor at that point —
 * see `usesAlternateScreen` in lib/cli-tools/types.ts for the sibling condition
 * (#1268), where the same thing happens at `pane_height` instead.
 *
 * Raising `windowLines` does not avoid this; it only moves where it happens
 * (`TMUX_HISTORY_LIMIT` is the hard ceiling), which is why the check is written
 * against the window in use rather than against a specific constant.
 *
 * @param capturedLineCount - Number of lines the capture actually returned
 * @param windowLines - Size of the capture window that produced it
 * @returns True when the capture was clipped, i.e. the line count is no longer a cursor
 */
export function isCaptureWindowSaturated(
  capturedLineCount: number,
  windowLines: number = CACHE_MAX_CAPTURE_LINES
): boolean {
  return windowLines > 0 && capturedLineCount >= windowLines;
}

// =========================================================================
// globalThis pattern (Next.js hot reload persistence)
// =========================================================================

declare global {
  // eslint-disable-next-line no-var
  var __tmuxCaptureCache: Map<string, CacheEntry> | undefined;
  // eslint-disable-next-line no-var
  var __tmuxCaptureCacheInflight: Map<string, Promise<string>> | undefined;
  // eslint-disable-next-line no-var
  var __tmuxCaptureCacheGeneration: GenerationState | undefined;
}

/**
 * Invalidation generations (Issue #3734).
 * `global` advances on clearAllCache(); `sessions` holds the per-session count
 * that invalidateCache() advances. A capture records both before it starts and
 * writes back only when neither moved while it was waiting.
 */
interface GenerationState {
  global: number;
  sessions: Map<string, number>;
}

/** Snapshot of the invalidation generation taken before a capture starts. */
export interface CaptureGeneration {
  readonly global: number;
  readonly session: number;
}

function getCache(): Map<string, CacheEntry> {
  return getOrInitGlobal('__tmuxCaptureCache', () => new Map<string, CacheEntry>());
}

function getInflight(): Map<string, Promise<string>> {
  return getOrInitGlobal('__tmuxCaptureCacheInflight', () => new Map<string, Promise<string>>());
}

function getGenerationState(): GenerationState {
  return getOrInitGlobal('__tmuxCaptureCacheGeneration', () => ({ global: 0, sessions: new Map<string, number>() }));
}

// =========================================================================
// getCaptureGeneration() / isCaptureGenerationCurrent()
// =========================================================================

/**
 * Take the invalidation generation for a session before starting a capture
 * (Issue #3734). Pass it to isCaptureGenerationCurrent() after the await.
 *
 * @param sessionName - tmux session name
 * @returns Generation snapshot
 */
export function getCaptureGeneration(sessionName: string): CaptureGeneration {
  const state = getGenerationState();
  return { global: state.global, session: state.sessions.get(sessionName) ?? 0 };
}

/**
 * Whether no invalidateCache(sessionName) / clearAllCache() ran since the
 * snapshot was taken (Issue #3734). A capture that started before the
 * invalidation may show the screen from before a send, so it must not be
 * written back to the cache.
 *
 * @param sessionName - tmux session name
 * @param generation - Snapshot from getCaptureGeneration()
 * @returns True when the capture may be written back
 */
export function isCaptureGenerationCurrent(sessionName: string, generation: CaptureGeneration): boolean {
  const current = getCaptureGeneration(sessionName);
  return current.global === generation.global && current.session === generation.session;
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
 * @param fetchStartedAt - When the capture began (Issue #3798); defaults to
 *   now, the write time, for a writer that does not know it
 */
export function setCachedCapture(
  sessionName: string,
  output: string,
  capturedLines: number,
  fetchStartedAt?: number
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
    fetchStartedAt: fetchStartedAt ?? now,
  });
}

/**
 * When the cached capture of `sessionName` was started, or null when nothing
 * live is cached (Issue #3798). Read-only: an expired entry is left for the
 * next read to evict.
 *
 * @param sessionName - tmux session name (cache key)
 */
export function getCachedCaptureFetchStartedAt(sessionName: string): number | null {
  const entry = getCache().get(sessionName);
  if (!entry || Date.now() - entry.timestamp > CACHE_TTL_MS) return null;
  return entry.fetchStartedAt;
}

// =========================================================================
// invalidateCache()
// =========================================================================

/**
 * Invalidate cache for a specific session.
 * Issue #3734: also advances the session's generation and drops its inflight
 * entry, so a capture started before the invalidation is neither written back
 * nor joined by callers that arrive after it (they start a fresh capture).
 * [SEC4-006] Logs debug message with session name for troubleshooting.
 *
 * @param sessionName - tmux session name to invalidate
 */
export function invalidateCache(sessionName: string): void {
  const cache = getCache();
  cache.delete(sessionName);

  const generations = getGenerationState().sessions;
  generations.set(sessionName, (generations.get(sessionName) ?? 0) + 1);
  getInflight().delete(sessionName);

  // [SEC4-006] Debug log for cache invalidation chain tracking
  logger.debug('cache:invalidate', { sessionName });
}

// =========================================================================
// clearAllCache()
// =========================================================================

/**
 * Clear all cache entries and inflight requests for every session.
 * Called at the start of a worktree's session cleanup (session-cleanup.ts).
 * Issue #3734: advances the global generation so captures started before the
 * clear are not written back. Per-session counts are dropped here because the
 * global generation alone already tells every older snapshot apart.
 */
export function clearAllCache(): void {
  const cache = getCache();
  cache.clear();

  const inflight = getInflight();
  inflight.clear();

  const state = getGenerationState();
  state.global += 1;
  state.sessions.clear();
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
  globalThis.__tmuxCaptureCacheGeneration = undefined;
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
  // Issue #3734: snapshot the generation before fetchFn() starts
  const generation = getCaptureGeneration(sessionName);
  const fetchStartedAt = Date.now();
  const fetchPromise = fetchFn();
  inflight.set(sessionName, fetchPromise);

  try {
    const output = await fetchPromise;

    // Cache non-empty results only [SEC4-007], and only when no invalidation
    // happened while waiting (Issue #3734)
    if (output.length > 0 && isCaptureGenerationCurrent(sessionName, generation)) {
      setCachedCapture(sessionName, output, CACHE_MAX_CAPTURE_LINES, fetchStartedAt);
    }

    return sliceOutput(output, requestedLines);
  } finally {
    // Clean up inflight entry, unless an invalidation already replaced it
    // with a newer fetch (Issue #3734)
    if (inflight.get(sessionName) === fetchPromise) {
      inflight.delete(sessionName);
    }
  }
}
