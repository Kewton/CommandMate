/**
 * Unit Tests for useFileContentPolling hook
 *
 * Issue #469: File auto-update - file content polling
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileContentPolling } from '@/hooks/useFileContentPolling';
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
});
