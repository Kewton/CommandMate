/**
 * Unit tests for useWorktreesCache
 * Issue #600: UX refresh - shared worktree cache
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import {
  useWorktreesCache,
  POLLING_INTERVAL_ACTIVE,
  POLLING_INTERVAL_IDLE,
} from '@/hooks/useWorktreesCache';

// Mock global fetch
const mockFetch = vi.fn();
globalThis.fetch = mockFetch;

describe('useWorktreesCache()', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should start with isLoading=true and empty worktrees', () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ worktrees: [] }),
    });

    const { result } = renderHook(() => useWorktreesCache());
    expect(result.current.isLoading).toBe(true);
    expect(result.current.worktrees).toEqual([]);
    expect(result.current.error).toBeNull();
  });

  it('should fetch worktrees on mount', async () => {
    const mockWorktrees = [{ id: 'wt-1', name: 'main' }];
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ worktrees: mockWorktrees }),
    });

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worktrees).toEqual(mockWorktrees);
    expect(result.current.error).toBeNull();
    expect(mockFetch).toHaveBeenCalledWith('/api/worktrees');
  });

  it('should handle fetch error', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
    });

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error).toBeInstanceOf(Error);
    expect(result.current.error?.message).toContain('500');
    expect(result.current.worktrees).toEqual([]);
  });

  it('should handle network error', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network failure'));

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.error?.message).toBe('Network failure');
  });

  it('should refresh when refresh() is called', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ worktrees: [{ id: '1' }] }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ worktrees: [{ id: '1' }, { id: '2' }] }),
      });

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worktrees).toHaveLength(1);

    await act(async () => {
      await result.current.refresh();
    });

    expect(result.current.worktrees).toHaveLength(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('should handle missing worktrees field in response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({}),
    });

    const { result } = renderHook(() => useWorktreesCache());

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.worktrees).toEqual([]);
  });

  describe('polling constants', () => {
    it('should export POLLING_INTERVAL_ACTIVE as 5000', () => {
      expect(POLLING_INTERVAL_ACTIVE).toBe(5000);
    });

    it('should export POLLING_INTERVAL_IDLE as 30000', () => {
      expect(POLLING_INTERVAL_IDLE).toBe(30000);
    });
  });

  describe('adaptive polling', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('should poll with idle interval when no sessions are running', async () => {
      const idleWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: false }];
      // Always resolve with idle worktrees
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ worktrees: idleWorktrees }),
      });

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      const fetchCountAfterInit = mockFetch.mock.calls.length;

      // Advance by less than IDLE interval - should NOT poll
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_IDLE - 100);
      });
      expect(mockFetch).toHaveBeenCalledTimes(fetchCountAfterInit);

      // Advance past idle interval threshold
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });

      // Should have polled once more
      expect(mockFetch).toHaveBeenCalledTimes(fetchCountAfterInit + 1);
    });

    it('should poll with active interval when sessions are running', async () => {
      const activeWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: true }];
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ worktrees: activeWorktrees }),
      });

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      const fetchCountAfterInit = mockFetch.mock.calls.length;

      // Advance past active interval
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_ACTIVE + 100);
      });

      // Should have polled at least once more
      expect(mockFetch.mock.calls.length).toBeGreaterThan(fetchCountAfterInit);
    });

    it('should stop polling on unmount', async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ worktrees: [{ id: 'wt-1', name: 'main' }] }),
      });

      const { unmount } = renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      const fetchCountAfterInit = mockFetch.mock.calls.length;
      unmount();

      // Advance time - should not trigger more fetches after unmount
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_IDLE * 3);
      });

      expect(mockFetch).toHaveBeenCalledTimes(fetchCountAfterInit);
    });

    /**
     * Issue #710: Adaptive polling must update the interval when the
     * worktree active/idle state changes.
     */
    it('should switch from idle to active interval when a session starts', async () => {
      const idleWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: false }];
      const activeWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: true }];

      // First fetch: idle. Subsequent fetches: active.
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          worktrees:
            mockFetch.mock.calls.length === 1 ? idleWorktrees : activeWorktrees,
        }),
      }));

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // After idle interval - second fetch happens (returns active worktrees)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_IDLE);
      });
      const fetchCountAfterIdleTick = mockFetch.mock.calls.length;
      expect(fetchCountAfterIdleTick).toBeGreaterThanOrEqual(2);

      // The hook should now have switched to ACTIVE interval (5s).
      // Advance just past ACTIVE interval - should trigger another fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_ACTIVE + 100);
      });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(fetchCountAfterIdleTick);
    });

    it('should switch from active to idle interval when all sessions stop', async () => {
      const activeWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: true }];
      const idleWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: false }];

      // First fetch: active. Subsequent fetches: idle.
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          worktrees:
            mockFetch.mock.calls.length === 1 ? activeWorktrees : idleWorktrees,
        }),
      }));

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // After active interval - second fetch happens (returns idle worktrees)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_ACTIVE + 100);
      });
      const fetchCountAfterActiveTick = mockFetch.mock.calls.length;
      expect(fetchCountAfterActiveTick).toBeGreaterThanOrEqual(2);

      // The hook should now have switched to IDLE interval (30s).
      // Advancing by ACTIVE interval should NOT trigger another fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_ACTIVE + 100);
      });
      expect(mockFetch.mock.calls.length).toBe(fetchCountAfterActiveTick);

      // Advance the rest of the IDLE interval - should trigger a fetch.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(
          POLLING_INTERVAL_IDLE - POLLING_INTERVAL_ACTIVE,
        );
      });
      expect(mockFetch.mock.calls.length).toBeGreaterThan(fetchCountAfterActiveTick);
    });

    it('should not restart interval when active state does not change', async () => {
      const idleWorktreesA = [{ id: 'wt-1', name: 'main', isSessionRunning: false }];
      const idleWorktreesB = [{ id: 'wt-2', name: 'feature', isSessionRunning: false }];

      // Alternate worktrees identity but keep isSessionRunning=false throughout.
      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          worktrees:
            mockFetch.mock.calls.length % 2 === 1 ? idleWorktreesA : idleWorktreesB,
        }),
      }));

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      const fetchCountAfterInit = mockFetch.mock.calls.length;

      // Advance just less than IDLE interval - should not trigger a fetch
      // even though worktrees identity changes are happening.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_IDLE - 100);
      });
      // No-op: same desired interval, so the setInterval timer should still
      // be the original one and should not have fired yet.
      expect(mockFetch.mock.calls.length).toBe(fetchCountAfterInit);

      // After the rest of the IDLE interval - the (original) timer fires.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200);
      });
      expect(mockFetch.mock.calls.length).toBe(fetchCountAfterInit + 1);
    });

    it('should not restart polling when tab is hidden', async () => {
      const idleWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: false }];
      const activeWorktrees = [{ id: 'wt-1', name: 'main', isSessionRunning: true }];

      mockFetch.mockImplementation(async () => ({
        ok: true,
        json: async () => ({
          worktrees:
            mockFetch.mock.calls.length === 1 ? idleWorktrees : activeWorktrees,
        }),
      }));

      renderHook(() => useWorktreesCache());

      // Flush initial fetch + setTimeout(startPolling, 0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
      });

      // Set tab hidden and dispatch visibilitychange so polling stops.
      const originalHidden = Object.getOwnPropertyDescriptor(
        Document.prototype,
        'hidden',
      );
      Object.defineProperty(document, 'hidden', {
        value: true,
        configurable: true,
      });
      document.dispatchEvent(new Event('visibilitychange'));

      const fetchCountAfterHidden = mockFetch.mock.calls.length;

      // Even after the IDLE interval elapses, no fetch should run because
      // the tab is hidden. The worktrees state ref still reflects idle
      // (since no second poll has run yet).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_IDLE * 2);
      });
      expect(mockFetch.mock.calls.length).toBe(fetchCountAfterHidden);

      // Restore document.hidden for subsequent tests.
      if (originalHidden) {
        Object.defineProperty(Document.prototype, 'hidden', originalHidden);
      }
      Object.defineProperty(document, 'hidden', {
        value: false,
        configurable: true,
      });
    });
  });
});
