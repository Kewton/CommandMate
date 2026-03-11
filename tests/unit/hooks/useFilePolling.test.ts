/**
 * Unit Tests for useFilePolling hook
 *
 * Issue #469: File auto-update (external change detection)
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFilePolling } from '@/hooks/useFilePolling';

describe('useFilePolling', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('should call onPoll at the specified interval when enabled', () => {
    const onPoll = vi.fn();
    renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: true, onPoll }),
    );

    expect(onPoll).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('should not call onPoll when disabled', () => {
    const onPoll = vi.fn();
    renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: false, onPoll }),
    );

    act(() => {
      vi.advanceTimersByTime(15000);
    });
    expect(onPoll).not.toHaveBeenCalled();
  });

  it('should stop polling when enabled changes from true to false', () => {
    const onPoll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useFilePolling({ intervalMs: 5000, enabled, onPoll }),
      { initialProps: { enabled: true } },
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);

    rerender({ enabled: false });

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it('should start polling when enabled changes from false to true', () => {
    const onPoll = vi.fn();
    const { rerender } = renderHook(
      ({ enabled }) => useFilePolling({ intervalMs: 5000, enabled, onPoll }),
      { initialProps: { enabled: false } },
    );

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onPoll).not.toHaveBeenCalled();

    rerender({ enabled: true });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(1);
  });

  it('should cleanup interval on unmount', () => {
    const onPoll = vi.fn();
    const { unmount } = renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: true, onPoll }),
    );

    unmount();

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onPoll).not.toHaveBeenCalled();
  });

  it('should stop polling when document becomes hidden and resume when visible', () => {
    const onPoll = vi.fn();
    renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: true, onPoll }),
    );

    // Simulate document becoming hidden
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    act(() => {
      vi.advanceTimersByTime(10000);
    });
    expect(onPoll).not.toHaveBeenCalled();

    // Simulate document becoming visible again
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    // Should call onPoll immediately on visible
    expect(onPoll).toHaveBeenCalledTimes(1);

    // Should resume interval
    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll).toHaveBeenCalledTimes(2);
  });

  it('should use the latest onPoll callback via ref', () => {
    const onPoll1 = vi.fn();
    const onPoll2 = vi.fn();
    const { rerender } = renderHook(
      ({ onPoll }) => useFilePolling({ intervalMs: 5000, enabled: true, onPoll }),
      { initialProps: { onPoll: onPoll1 } },
    );

    rerender({ onPoll: onPoll2 });

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(onPoll1).not.toHaveBeenCalled();
    expect(onPoll2).toHaveBeenCalledTimes(1);
  });

  it('should not resume polling on visible when disabled', () => {
    const onPoll = vi.fn();
    renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: false, onPoll }),
    );

    // Simulate document becoming hidden then visible
    Object.defineProperty(document, 'visibilityState', {
      value: 'hidden',
      writable: true,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    Object.defineProperty(document, 'visibilityState', {
      value: 'visible',
      writable: true,
      configurable: true,
    });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(onPoll).not.toHaveBeenCalled();
  });

  it('should cleanup visibilitychange listener on unmount', () => {
    const onPoll = vi.fn();
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { unmount } = renderHook(() =>
      useFilePolling({ intervalMs: 5000, enabled: true, onPoll }),
    );

    unmount();

    expect(removeSpy).toHaveBeenCalledWith(
      'visibilitychange',
      expect.any(Function),
    );
    removeSpy.mockRestore();
  });
});
