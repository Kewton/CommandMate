/**
 * Unit tests for useWorktreesCache
 * Issue #600: UX refresh - shared worktree cache
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { useWorktreesCache } from '@/hooks/useWorktreesCache';

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
});
