/**
 * Tests for useInfiniteMessages hook
 *
 * Tests infinite scroll message loading functionality
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useInfiniteMessages } from '@/hooks/useInfiniteMessages';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useInfiniteMessages', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  const createMockMessages = (count: number, startOffset: number = 0) => {
    return Array.from({ length: count }, (_, i) => ({
      id: `msg-${startOffset + i}`,
      worktreeId: 'wt-1',
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `Message ${startOffset + i}`,
      timestamp: new Date(Date.now() - (startOffset + i) * 60000).toISOString(),
    }));
  };

  describe('Initial state', () => {
    it('should return initial loading state', () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      expect(result.current.isLoading).toBe(true);
      expect(result.current.messages).toEqual([]);
      expect(result.current.error).toBeNull();
    });

    it('should provide all required return values', () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      expect(result.current.messages).toBeDefined();
      expect(result.current.conversationPairs).toBeDefined();
      expect(result.current.isLoading).toBeDefined();
      expect(result.current.isLoadingOlder).toBeDefined();
      expect(result.current.isRefreshing).toBeDefined();
      expect(result.current.hasMore).toBeDefined();
      expect(typeof result.current.loadMore).toBe('function');
      expect(result.current.error).toBeDefined();
      expect(typeof result.current.retry).toBe('function');
      expect(typeof result.current.refresh).toBe('function');
      expect(typeof result.current.clearCache).toBe('function');
    });
  });

  describe('Initial load', () => {
    it('should fetch initial messages on mount', async () => {
      const mockMessages = createMockMessages(10);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining('/api/worktrees/wt-1/messages')
      );
      expect(result.current.messages).toHaveLength(10);
    });

    it('should set hasMore to true when fetched count equals pageSize', async () => {
      const mockMessages = createMockMessages(50); // Default pageSize is 50
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hasMore).toBe(true);
    });

    it('should set hasMore to false when fetched count is less than pageSize', async () => {
      const mockMessages = createMockMessages(30);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hasMore).toBe(false);
    });
  });

  describe('loadMore', () => {
    it('should fetch older messages when loadMore is called', async () => {
      // Initial fetch
      const initialMessages = createMockMessages(50);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Load more
      const olderMessages = createMockMessages(50, 50);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(olderMessages),
      });

      await act(async () => {
        await result.current.loadMore();
      });

      expect(result.current.messages).toHaveLength(100);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should not loadMore when hasMore is false', async () => {
      const mockMessages = createMockMessages(30);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.hasMore).toBe(false);

      // Try to load more
      await act(async () => {
        await result.current.loadMore();
      });

      // Should not have made another fetch
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('should set isLoadingOlder while fetching older messages', async () => {
      const initialMessages = createMockMessages(50);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Setup delayed response
      let resolveLoadMore: (value: unknown) => void;
      const loadMorePromise = new Promise((resolve) => {
        resolveLoadMore = resolve;
      });
      mockFetch.mockReturnValueOnce({
        ok: true,
        json: () => loadMorePromise,
      });

      // Start loading more
      act(() => {
        result.current.loadMore();
      });

      expect(result.current.isLoadingOlder).toBe(true);

      // Resolve the load
      await act(async () => {
        resolveLoadMore!(createMockMessages(50, 50));
      });

      expect(result.current.isLoadingOlder).toBe(false);
    });
  });

  describe('Error handling', () => {
    it('should set error state on network failure', async () => {
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.code).toBe('NETWORK_ERROR');
      expect(result.current.error?.retryable).toBe(true);
    });

    it('should set error state on server error', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.error).not.toBeNull();
      expect(result.current.error?.retryable).toBe(true);
    });

    it('should allow retry after error', async () => {
      // First call fails
      mockFetch.mockRejectedValueOnce(new TypeError('fetch failed'));

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.error).not.toBeNull();
      });

      // Setup successful retry
      const mockMessages = createMockMessages(10);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      await act(async () => {
        await result.current.retry();
      });

      expect(result.current.error).toBeNull();
      expect(result.current.messages).toHaveLength(10);
    });
  });

  describe('refresh', () => {
    it('should clear and refetch messages', async () => {
      const initialMessages = createMockMessages(10);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Setup refresh
      const newMessages = createMockMessages(5);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(newMessages),
      });

      await act(async () => {
        await result.current.refresh();
      });

      expect(result.current.messages).toHaveLength(5);
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it('should set isRefreshing while refreshing', async () => {
      const initialMessages = createMockMessages(10);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      // Setup delayed refresh
      let resolveRefresh: (value: unknown) => void;
      const refreshPromise = new Promise((resolve) => {
        resolveRefresh = resolve;
      });
      mockFetch.mockReturnValueOnce({
        ok: true,
        json: () => refreshPromise,
      });

      // Start refresh
      act(() => {
        result.current.refresh();
      });

      expect(result.current.isRefreshing).toBe(true);

      // Resolve
      await act(async () => {
        resolveRefresh!(createMockMessages(5));
      });

      expect(result.current.isRefreshing).toBe(false);
    });
  });

  describe('clearCache', () => {
    it('should clear all cached messages', async () => {
      const initialMessages = createMockMessages(10);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.messages).toHaveLength(10);

      act(() => {
        result.current.clearCache();
      });

      expect(result.current.messages).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle empty worktree', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve([]),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.messages).toHaveLength(0);
      expect(result.current.hasMore).toBe(false);
    });

    it('should not allow loadMore when already loading older messages', async () => {
      const initialMessages = createMockMessages(50);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(initialMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          pageSize: 50,
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      const initialCallCount = mockFetch.mock.calls.length;

      // Setup a slow response
      let resolveLoadMore: (value: unknown) => void;
      const loadMorePromise = new Promise((resolve) => {
        resolveLoadMore = resolve;
      });
      mockFetch.mockReturnValueOnce({
        ok: true,
        json: () => loadMorePromise,
      });

      // Start first loadMore (this will set isLoadingOlder = true)
      act(() => {
        result.current.loadMore();
      });

      // At this point, isLoadingOlder should be true
      expect(result.current.isLoadingOlder).toBe(true);

      // Calling loadMore again should be a no-op
      act(() => {
        result.current.loadMore();
      });

      // Only 1 additional fetch should have been made
      expect(mockFetch.mock.calls.length - initialCallCount).toBe(1);

      // Resolve the pending request
      await act(async () => {
        resolveLoadMore!(createMockMessages(50, 50));
      });

      expect(result.current.isLoadingOlder).toBe(false);
    });
  });

  describe('conversationPairs', () => {
    it('should group messages into conversation pairs', async () => {
      const mockMessages = [
        {
          id: 'msg-1',
          worktreeId: 'wt-1',
          role: 'user',
          content: 'Hello',
          timestamp: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          worktreeId: 'wt-1',
          role: 'assistant',
          content: 'Hi there',
          timestamp: new Date().toISOString(),
        },
      ];
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(mockMessages),
      });

      const { result } = renderHook(() =>
        useInfiniteMessages({
          worktreeId: 'wt-1',
          cliToolId: 'claude',
        })
      );

      await waitFor(() => {
        expect(result.current.isLoading).toBe(false);
      });

      expect(result.current.conversationPairs).toBeDefined();
      expect(result.current.conversationPairs.length).toBeGreaterThan(0);
    });
  });
});
