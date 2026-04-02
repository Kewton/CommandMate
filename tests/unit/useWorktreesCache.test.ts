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
  });
});
