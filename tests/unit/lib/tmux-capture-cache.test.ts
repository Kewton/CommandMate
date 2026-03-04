/**
 * Tests for tmux-capture-cache.ts
 * Issue #405: tmux capture optimization - cache module
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getCachedCapture,
  setCachedCapture,
  sliceOutput,
  invalidateCache,
  clearAllCache,
  resetCacheForTesting,
  getOrFetchCapture,
  CACHE_TTL_MS,
  CACHE_MAX_ENTRIES,
  CACHE_MAX_CAPTURE_LINES,
} from '@/lib/tmux-capture-cache';

describe('tmux-capture-cache', () => {
  beforeEach(() => {
    resetCacheForTesting();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetCacheForTesting();
  });

  // =========================================================================
  // Constants
  // =========================================================================

  describe('constants', () => {
    it('should export CACHE_TTL_MS as 2000', () => {
      expect(CACHE_TTL_MS).toBe(2000);
    });

    it('should export CACHE_MAX_ENTRIES as 100', () => {
      expect(CACHE_MAX_ENTRIES).toBe(100);
    });

    it('should export CACHE_MAX_CAPTURE_LINES as 10000', () => {
      expect(CACHE_MAX_CAPTURE_LINES).toBe(10000);
    });
  });

  // =========================================================================
  // sliceOutput()
  // =========================================================================

  describe('sliceOutput', () => {
    it('should return full output when requestedLines >= actual lines', () => {
      const output = 'line1\nline2\nline3';
      expect(sliceOutput(output, 5)).toBe(output);
    });

    it('should return full output when requestedLines == actual lines', () => {
      const output = 'line1\nline2\nline3';
      expect(sliceOutput(output, 3)).toBe(output);
    });

    it('should slice last N lines when requestedLines < actual lines', () => {
      const output = 'line1\nline2\nline3\nline4\nline5';
      expect(sliceOutput(output, 2)).toBe('line4\nline5');
    });

    it('should handle single line output', () => {
      const output = 'single line';
      expect(sliceOutput(output, 1)).toBe('single line');
    });

    it('should handle empty output', () => {
      expect(sliceOutput('', 10)).toBe('');
    });

    it('should handle output with trailing newline (off-by-one check) [DA3-001]', () => {
      const output = 'line1\nline2\nline3\n';
      // 4 elements after split: ['line1', 'line2', 'line3', '']
      const result = sliceOutput(output, 2);
      // last 2 elements: 'line3' and ''
      expect(result).toBe('line3\n');
    });

    it('should handle large output (10000 lines)', () => {
      const lines = Array.from({ length: 10000 }, (_, i) => `line${i + 1}`);
      const output = lines.join('\n');
      const result = sliceOutput(output, 100);
      const resultLines = result.split('\n');
      expect(resultLines.length).toBe(100);
      expect(resultLines[0]).toBe('line9901');
      expect(resultLines[99]).toBe('line10000');
    });

    it('should handle requestedLines = 1', () => {
      const output = 'line1\nline2\nline3';
      expect(sliceOutput(output, 1)).toBe('line3');
    });

    it('should verify split consistency [DA3-001]', () => {
      const output = 'a\nb\nc\nd\ne';
      const splitCount = output.split('\n').length;
      expect(splitCount).toBe(5);
      const sliced = sliceOutput(output, 3);
      expect(sliced.split('\n').length).toBe(3);
    });
  });

  // =========================================================================
  // getCachedCapture() / setCachedCapture()
  // =========================================================================

  describe('getCachedCapture and setCachedCapture', () => {
    it('should return null for cache miss', () => {
      expect(getCachedCapture('session-1', 100)).toBeNull();
    });

    it('should return cached output on hit', () => {
      const output = 'line1\nline2\nline3';
      setCachedCapture('session-1', output, 100);
      expect(getCachedCapture('session-1', 100)).toBe(output);
    });

    it('should return sliced output when requestedLines < capturedLines', () => {
      const output = 'line1\nline2\nline3\nline4\nline5';
      setCachedCapture('session-1', output, 5000);
      const result = getCachedCapture('session-1', 2);
      expect(result).toBe('line4\nline5');
    });

    it('should return null when requestedLines > capturedLines', () => {
      const output = 'line1\nline2\nline3';
      setCachedCapture('session-1', output, 100);
      // Requesting more lines than what was captured
      expect(getCachedCapture('session-1', 200)).toBeNull();
    });

    it('should return null for TTL-expired entries (lazy eviction)', () => {
      const output = 'line1\nline2';
      setCachedCapture('session-1', output, 100);

      // Advance time past TTL
      vi.useFakeTimers();
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      expect(getCachedCapture('session-1', 100)).toBeNull();

      vi.useRealTimers();
    });

    it('should delete TTL-expired entry on lazy eviction', () => {
      const output = 'test output';
      setCachedCapture('session-1', output, 100);

      vi.useFakeTimers();
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      // First call returns null and deletes
      getCachedCapture('session-1', 100);
      vi.useRealTimers();

      // Subsequent call also returns null (entry deleted)
      expect(getCachedCapture('session-1', 100)).toBeNull();
    });

    it('should perform full sweep on setCachedCapture [SEC4-002]', () => {
      vi.useFakeTimers();
      const now = Date.now();

      // Set multiple entries
      setCachedCapture('session-1', 'output1', 100);
      setCachedCapture('session-2', 'output2', 100);

      // Advance past TTL
      vi.advanceTimersByTime(CACHE_TTL_MS + 1);

      // Set new entry - should sweep expired entries
      setCachedCapture('session-3', 'output3', 100);

      vi.useRealTimers();

      // Expired entries should be gone
      expect(getCachedCapture('session-1', 100)).toBeNull();
      expect(getCachedCapture('session-2', 100)).toBeNull();
      // New entry should exist
      expect(getCachedCapture('session-3', 100)).toBe('output3');
    });

    it('should enforce CACHE_MAX_ENTRIES limit', () => {
      // Fill cache to max
      for (let i = 0; i < CACHE_MAX_ENTRIES; i++) {
        setCachedCapture(`session-${i}`, `output-${i}`, 100);
      }

      // Add one more - should evict oldest
      setCachedCapture('session-new', 'output-new', 100);

      // New entry should exist
      expect(getCachedCapture('session-new', 100)).toBe('output-new');

      // At least one old entry should be gone (oldest evicted)
      expect(getCachedCapture('session-0', 100)).toBeNull();
    });

    it('should handle overwriting existing entries', () => {
      setCachedCapture('session-1', 'old output', 100);
      setCachedCapture('session-1', 'new output', 200);

      expect(getCachedCapture('session-1', 200)).toBe('new output');
    });
  });

  // =========================================================================
  // invalidateCache()
  // =========================================================================

  describe('invalidateCache', () => {
    it('should remove specific session from cache', () => {
      setCachedCapture('session-1', 'output1', 100);
      setCachedCapture('session-2', 'output2', 100);

      invalidateCache('session-1');

      expect(getCachedCapture('session-1', 100)).toBeNull();
      expect(getCachedCapture('session-2', 100)).toBe('output2');
    });

    it('should handle invalidating non-existent session gracefully', () => {
      expect(() => invalidateCache('non-existent')).not.toThrow();
    });

    it('should log debug message [SEC4-006]', () => {
      const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});
      setCachedCapture('session-1', 'output', 100);

      invalidateCache('session-1');

      expect(debugSpy).toHaveBeenCalledWith(
        expect.stringContaining('invalidateCache'),
        expect.objectContaining({ sessionName: 'session-1' })
      );
    });
  });

  // =========================================================================
  // clearAllCache()
  // =========================================================================

  describe('clearAllCache', () => {
    it('should clear all cache entries', () => {
      setCachedCapture('session-1', 'output1', 100);
      setCachedCapture('session-2', 'output2', 100);
      setCachedCapture('session-3', 'output3', 100);

      clearAllCache();

      expect(getCachedCapture('session-1', 100)).toBeNull();
      expect(getCachedCapture('session-2', 100)).toBeNull();
      expect(getCachedCapture('session-3', 100)).toBeNull();
    });

    it('should handle clearing empty cache', () => {
      expect(() => clearAllCache()).not.toThrow();
    });
  });

  // =========================================================================
  // resetCacheForTesting()
  // =========================================================================

  describe('resetCacheForTesting', () => {
    it('should clear both cache and inflight maps', () => {
      setCachedCapture('session-1', 'output', 100);
      resetCacheForTesting();
      expect(getCachedCapture('session-1', 100)).toBeNull();
    });
  });

  // =========================================================================
  // getOrFetchCapture() - singleflight pattern
  // =========================================================================

  describe('getOrFetchCapture', () => {
    it('should call fetchFn on cache miss', async () => {
      const fetchFn = vi.fn().mockResolvedValue('fetched output');

      const result = await getOrFetchCapture('session-1', 100, fetchFn);

      expect(fetchFn).toHaveBeenCalledOnce();
      expect(result).toBe('fetched output');
    });

    it('should use cache on cache hit', async () => {
      setCachedCapture('session-1', 'cached output', 100);
      const fetchFn = vi.fn().mockResolvedValue('fetched output');

      const result = await getOrFetchCapture('session-1', 100, fetchFn);

      expect(fetchFn).not.toHaveBeenCalled();
      expect(result).toBe('cached output');
    });

    it('should populate cache after successful fetch', async () => {
      const fetchFn = vi.fn().mockResolvedValue('fetched output');

      await getOrFetchCapture('session-1', 100, fetchFn);

      // Cache should now be populated
      expect(getCachedCapture('session-1', 100)).toBe('fetched output');
    });

    it('should deduplicate concurrent requests (singleflight)', async () => {
      let resolvePromise: (value: string) => void;
      const pendingPromise = new Promise<string>((resolve) => {
        resolvePromise = resolve;
      });

      const fetchFn = vi.fn().mockReturnValue(pendingPromise);

      // Start two concurrent requests
      const promise1 = getOrFetchCapture('session-1', 100, fetchFn);
      const promise2 = getOrFetchCapture('session-1', 100, fetchFn);

      // Only one fetch should be in-flight
      expect(fetchFn).toHaveBeenCalledOnce();

      // Resolve the promise
      resolvePromise!('shared result');

      const [result1, result2] = await Promise.all([promise1, promise2]);
      expect(result1).toBe('shared result');
      expect(result2).toBe('shared result');
    });

    it('should clean up inflight map after fetch completes', async () => {
      const fetchFn = vi.fn().mockResolvedValue('output');

      await getOrFetchCapture('session-1', 100, fetchFn);

      // Second call should trigger a new fetch (inflight should be cleaned up)
      await getOrFetchCapture('session-1', 100, fetchFn);
      // Second call uses cache, so fetchFn is still called once
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('should propagate errors from fetchFn', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('fetch failed'));

      await expect(getOrFetchCapture('session-1', 100, fetchFn)).rejects.toThrow('fetch failed');
    });

    it('should clean up inflight map after fetch error', async () => {
      const fetchFn = vi.fn()
        .mockRejectedValueOnce(new Error('first failure'))
        .mockResolvedValueOnce('success');

      // First call fails
      await expect(getOrFetchCapture('session-1', 100, fetchFn)).rejects.toThrow('first failure');

      // Second call should create new fetch (inflight cleaned up)
      const result = await getOrFetchCapture('session-1', 100, fetchFn);
      expect(result).toBe('success');
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('should share error across concurrent requests', async () => {
      const fetchFn = vi.fn().mockRejectedValue(new Error('shared error'));

      const promise1 = getOrFetchCapture('session-1', 100, fetchFn);
      const promise2 = getOrFetchCapture('session-1', 100, fetchFn);

      await expect(promise1).rejects.toThrow('shared error');
      await expect(promise2).rejects.toThrow('shared error');
      expect(fetchFn).toHaveBeenCalledOnce();
    });

    it('should not cache empty results from fetchFn', async () => {
      const fetchFn = vi.fn().mockResolvedValue('');

      const result = await getOrFetchCapture('session-1', 100, fetchFn);

      expect(result).toBe('');
      // Empty result should not be cached
      expect(getCachedCapture('session-1', 100)).toBeNull();
    });

    it('should use CACHE_MAX_CAPTURE_LINES for cache storage', async () => {
      const lines = Array.from({ length: 200 }, (_, i) => `line${i + 1}`);
      const fullOutput = lines.join('\n');
      const fetchFn = vi.fn().mockResolvedValue(fullOutput);

      const result = await getOrFetchCapture('session-1', 100, fetchFn);

      // Should return sliced output for the requested lines
      const resultLines = result.split('\n');
      expect(resultLines.length).toBe(100);

      // Cache should store with CACHE_MAX_CAPTURE_LINES
      const cached = getCachedCapture('session-1', 200);
      expect(cached).toBe(fullOutput);
    });
  });
});
