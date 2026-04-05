/**
 * Unit tests for useGenerationStatus hook
 * Issue #638: Report generation status visibility - UI polling
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useGenerationStatus } from '@/hooks/useGenerationStatus';

describe('useGenerationStatus', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.useFakeTimers();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('should return generating: false initially', () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ generating: false }),
    });

    const { result } = renderHook(() => useGenerationStatus(true));
    expect(result.current.generating).toBe(false);
  });

  it('should fetch status on mount and update state', async () => {
    const startedAt = new Date().toISOString();
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        generating: true,
        date: '2026-04-05',
        tool: 'claude',
        startedAt,
      }),
    });

    const { result } = renderHook(() => useGenerationStatus(true));

    // Flush the initial fetch promise
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.generating).toBe(true);
    expect(result.current.date).toBe('2026-04-05');
    expect(result.current.tool).toBe('claude');
    expect(result.current.startedAt).toBe(startedAt);
  });

  it('should not poll when disabled', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ generating: false }),
    });

    renderHook(() => useGenerationStatus(false));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('should poll periodically when enabled', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ generating: false }),
    });

    renderHook(() => useGenerationStatus(true));

    // Flush initial fetch
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const initialCallCount = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    expect(initialCallCount).toBeGreaterThanOrEqual(1);

    // Advance by polling interval (5 seconds)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });

    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(initialCallCount);
  });

  it('should handle fetch errors gracefully', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

    const { result } = renderHook(() => useGenerationStatus(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    expect(result.current.generating).toBe(false);
  });

  it('should stop polling on unmount', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ generating: false }),
    });

    const { unmount } = renderHook(() => useGenerationStatus(true));

    await act(async () => {
      await vi.advanceTimersByTimeAsync(100);
    });

    const callCountBeforeUnmount = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;
    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10000);
    });

    // No more calls after unmount
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callCountBeforeUnmount);
  });
});
