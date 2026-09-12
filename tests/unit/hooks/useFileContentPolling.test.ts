/**
 * Unit Tests for useFileContentPolling hook
 *
 * Issue #469: File auto-update - file content polling
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileContentPolling } from '@/hooks/useFileContentPolling';
import { API_POLL_TIMEOUT_MS } from '@/config/api-timeout-config';
import { __resetApiReachabilityReporting } from '@/lib/api-client';
import type { FileTab } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// Mock useFilePolling
const mockUseFilePolling = vi.fn();
vi.mock('@/hooks/useFilePolling', () => ({
  useFilePolling: (...args: unknown[]) => mockUseFilePolling(...args),
}));

// Mock fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('useFileContentPolling', () => {
  const mockContent: FileContent = {
    path: 'src/index.ts',
    content: 'const x = 1;',
    extension: 'ts',
    worktreePath: '/repo',
  };

  const baseTab: FileTab = {
    path: 'src/index.ts',
    name: 'index.ts',
    content: mockContent,
    loading: false,
    error: null,
    isDirty: false,
  };

  const onLoadContent = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockUseFilePolling.mockImplementation(() => {});
    __resetApiReachabilityReporting();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call useFilePolling with correct intervalMs', () => {
    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    expect(mockUseFilePolling).toHaveBeenCalledWith(
      expect.objectContaining({
        intervalMs: 5000,
      }),
    );
  });

  it('should be enabled when content is loaded, not loading, and not dirty', () => {
    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    expect(mockUseFilePolling).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: true,
      }),
    );
  });

  it('should be disabled when isDirty is true', () => {
    const dirtyTab: FileTab = { ...baseTab, isDirty: true };
    renderHook(() =>
      useFileContentPolling({ tab: dirtyTab, worktreeId: 'wt-1', onLoadContent }),
    );

    expect(mockUseFilePolling).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it('should be disabled when content is null', () => {
    const noContentTab: FileTab = { ...baseTab, content: null };
    renderHook(() =>
      useFileContentPolling({ tab: noContentTab, worktreeId: 'wt-1', onLoadContent }),
    );

    expect(mockUseFilePolling).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it('should be disabled when loading is true', () => {
    const loadingTab: FileTab = { ...baseTab, loading: true };
    renderHook(() =>
      useFileContentPolling({ tab: loadingTab, worktreeId: 'wt-1', onLoadContent }),
    );

    expect(mockUseFilePolling).toHaveBeenCalledWith(
      expect.objectContaining({
        enabled: false,
      }),
    );
  });

  it('should not send If-Modified-Since header on first poll', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'Last-Modified': 'Tue, 10 Mar 2026 12:00:00 GMT' }),
      json: async () => mockContent,
    });

    mockUseFilePolling.mockImplementation(({ onPoll }: { onPoll: () => void }) => {
      // Simulate first poll
      onPoll();
    });

    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    await vi.waitFor(() => {
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1]?.headers || {};
    expect(headers['If-Modified-Since']).toBeUndefined();
  });

  it('should call onLoadContent on 200 response', async () => {
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'Last-Modified': 'Tue, 10 Mar 2026 12:00:00 GMT' }),
      json: async () => mockContent,
    });

    let pollFn: (() => void) | null = null;
    mockUseFilePolling.mockImplementation(({ onPoll }: { onPoll: () => void }) => {
      pollFn = onPoll;
    });

    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    await act(async () => {
      pollFn?.();
    });

    expect(onLoadContent).toHaveBeenCalledWith('src/index.ts', mockContent);
  });

  it('should not call onLoadContent on 304 response', async () => {
    mockFetch.mockResolvedValue({
      status: 304,
      ok: false,
      headers: new Headers({ 'Last-Modified': 'Tue, 10 Mar 2026 12:00:00 GMT' }),
    });

    let pollFn: (() => void) | null = null;
    mockUseFilePolling.mockImplementation(({ onPoll }: { onPoll: () => void }) => {
      pollFn = onPoll;
    });

    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    await act(async () => {
      pollFn?.();
    });

    expect(onLoadContent).not.toHaveBeenCalled();
  });

  it('should not call onLoadContent on error response', async () => {
    mockFetch.mockResolvedValue({
      status: 500,
      ok: false,
      headers: new Headers(),
    });

    let pollFn: (() => void) | null = null;
    mockUseFilePolling.mockImplementation(({ onPoll }: { onPoll: () => void }) => {
      pollFn = onPoll;
    });

    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    await act(async () => {
      pollFn?.();
    });

    expect(onLoadContent).not.toHaveBeenCalled();
  });

  it('should send If-Modified-Since header on subsequent polls after 200', async () => {
    const lastModified = 'Tue, 10 Mar 2026 12:00:00 GMT';
    mockFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'Last-Modified': lastModified }),
      json: async () => mockContent,
    });

    let pollFn: (() => void) | null = null;
    mockUseFilePolling.mockImplementation(({ onPoll }: { onPoll: () => void }) => {
      pollFn = onPoll;
    });

    renderHook(() =>
      useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
    );

    // First poll (no If-Modified-Since)
    await act(async () => {
      pollFn?.();
    });

    // Second poll (should have If-Modified-Since)
    await act(async () => {
      pollFn?.();
    });

    const secondCall = mockFetch.mock.calls[1];
    expect(secondCall[1]?.headers?.['If-Modified-Since']).toBe(lastModified);
  });

  // [Issue #723] Large-file polling disable
  describe('large-file polling disable (Issue #723)', () => {
    it('should be enabled when totalBytes is undefined (backward compat)', () => {
      // baseTab.content has no totalBytes — must remain enabled
      renderHook(() =>
        useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
      );

      expect(mockUseFilePolling).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
    });

    it('should be enabled when totalBytes is below threshold', () => {
      const smallTab: FileTab = {
        ...baseTab,
        content: { ...mockContent, totalBytes: 512 * 1024 }, // 512KB
      };
      renderHook(() =>
        useFileContentPolling({ tab: smallTab, worktreeId: 'wt-1', onLoadContent }),
      );

      expect(mockUseFilePolling).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      );
    });

    it('should be disabled when totalBytes is exactly at threshold (1MB)', () => {
      const largeTab: FileTab = {
        ...baseTab,
        content: { ...mockContent, totalBytes: 1 * 1024 * 1024 },
      };
      renderHook(() =>
        useFileContentPolling({ tab: largeTab, worktreeId: 'wt-1', onLoadContent }),
      );

      expect(mockUseFilePolling).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });

    it('should be disabled when totalBytes exceeds the threshold', () => {
      const largeTab: FileTab = {
        ...baseTab,
        content: { ...mockContent, totalBytes: 5 * 1024 * 1024 },
      };
      renderHook(() =>
        useFileContentPolling({ tab: largeTab, worktreeId: 'wt-1', onLoadContent }),
      );

      expect(mockUseFilePolling).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
      );
    });
  });

  // [Issue #2499] The poll goes through the shared transport
  describe('bounded polling (Issue #2499)', () => {
    /** A request that neither resolves nor rejects until it is aborted. */
    function hangingFetch() {
      return (_url: string, init?: RequestInit) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('The operation was aborted.');
            error.name = 'AbortError';
            reject(error);
          });
        });
    }

    function capturePoll(): () => void | Promise<void> {
      let pollFn: (() => void | Promise<void>) | null = null;
      mockUseFilePolling.mockImplementation(
        ({ onPoll }: { onPoll: () => void | Promise<void> }) => {
          pollFn = onPoll;
        },
      );
      renderHook(() =>
        useFileContentPolling({ tab: baseTab, worktreeId: 'wt-1', onLoadContent }),
      );
      // Non-null by construction: the hook calls useFilePolling on first render.
      return pollFn as unknown as () => void | Promise<void>;
    }

    it('hands the request an AbortSignal, so a stalled poll can be cut off', async () => {
      mockFetch.mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'Last-Modified': 'Tue, 10 Mar 2026 12:00:00 GMT' }),
        json: async () => mockContent,
      });
      const pollFn = capturePoll();

      await act(async () => {
        await pollFn();
      });

      expect(mockFetch.mock.calls[0][1]?.signal).toBeInstanceOf(AbortSignal);
    });

    it('keeps the If-Modified-Since header the conditional request depends on', async () => {
      // The shared transport must pass `init` through untouched: rebuilding the
      // headers would drop this and turn every 304 back into a full body.
      mockFetch.mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'Last-Modified': 'Tue, 10 Mar 2026 12:00:00 GMT' }),
        json: async () => mockContent,
      });
      const pollFn = capturePoll();

      await act(async () => {
        await pollFn();
      });
      await act(async () => {
        await pollFn();
      });

      expect(mockFetch.mock.calls[1][1]?.headers?.['If-Modified-Since']).toBe(
        'Tue, 10 Mar 2026 12:00:00 GMT',
      );
    });

    it('aborts a hung poll at API_POLL_TIMEOUT_MS instead of waiting forever', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockImplementation(hangingFetch());
        const pollFn = capturePoll();

        let settled = false;
        await act(async () => {
          void Promise.resolve(pollFn()).then(() => {
            settled = true;
          });
          await vi.advanceTimersByTimeAsync(API_POLL_TIMEOUT_MS - 1);
        });
        expect(settled).toBe(false);

        await act(async () => {
          await vi.advanceTimersByTimeAsync(2);
        });

        // The hook swallows polling errors by design, so "settled" is the
        // observable: before #2499 this promise never settled at all, and the
        // next tick piled another hung request on top of it.
        expect(settled).toBe(true);
        expect(mockFetch.mock.calls[0][1].signal.aborted).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('issues exactly one request per tick — the next tick is the retry', async () => {
      vi.useFakeTimers();
      try {
        mockFetch.mockResolvedValue({ status: 500, ok: false, headers: new Headers() });
        const pollFn = capturePoll();

        await act(async () => {
          await pollFn();
          await vi.advanceTimersByTimeAsync(60_000);
        });

        // A transport-level retry ladder here would put three requests on a
        // link that is failing precisely because it cannot carry them, and
        // could still be retrying when the following tick fires.
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(onLoadContent).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
