/**
 * Tests for useExitAnimation hook (Issue #1114)
 *
 * Verifies that closed components stay rendered for the exit-animation
 * window before being released for unmount.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExitAnimation } from '@/hooks/useExitAnimation';

const DURATION = 200;

describe('useExitAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('initial state', () => {
    it('renders immediately when initially open', () => {
      const { result } = renderHook(() => useExitAnimation(true, DURATION));

      expect(result.current.shouldRender).toBe(true);
      expect(result.current.isExiting).toBe(false);
    });

    it('does not render when initially closed', () => {
      const { result } = renderHook(() => useExitAnimation(false, DURATION));

      expect(result.current.shouldRender).toBe(false);
      expect(result.current.isExiting).toBe(false);
    });
  });

  describe('exit window', () => {
    it('keeps rendering with isExiting=true after close, until duration elapses', () => {
      const { result, rerender } = renderHook(
        ({ open }) => useExitAnimation(open, DURATION),
        { initialProps: { open: true } }
      );

      rerender({ open: false });

      expect(result.current.shouldRender).toBe(true);
      expect(result.current.isExiting).toBe(true);

      // Just before the window ends the component is still rendered
      act(() => {
        vi.advanceTimersByTime(DURATION - 1);
      });
      expect(result.current.shouldRender).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.shouldRender).toBe(false);
      expect(result.current.isExiting).toBe(false);
    });

    it('respects a custom duration', () => {
      const { result, rerender } = renderHook(
        ({ open }) => useExitAnimation(open, 100),
        { initialProps: { open: true } }
      );

      rerender({ open: false });

      act(() => {
        vi.advanceTimersByTime(100);
      });
      expect(result.current.shouldRender).toBe(false);
    });
  });

  describe('reopening', () => {
    it('cancels the pending unmount when reopened during the exit window', () => {
      const { result, rerender } = renderHook(
        ({ open }) => useExitAnimation(open, DURATION),
        { initialProps: { open: true } }
      );

      rerender({ open: false });
      expect(result.current.isExiting).toBe(true);

      // Reopen halfway through the exit window
      act(() => {
        vi.advanceTimersByTime(DURATION / 2);
      });
      rerender({ open: true });

      expect(result.current.shouldRender).toBe(true);
      expect(result.current.isExiting).toBe(false);

      // The stale timer must not fire and hide the reopened component
      act(() => {
        vi.advanceTimersByTime(DURATION * 2);
      });
      expect(result.current.shouldRender).toBe(true);
    });

    it('renders again after a full close/reopen cycle', () => {
      const { result, rerender } = renderHook(
        ({ open }) => useExitAnimation(open, DURATION),
        { initialProps: { open: true } }
      );

      rerender({ open: false });
      act(() => {
        vi.advanceTimersByTime(DURATION);
      });
      expect(result.current.shouldRender).toBe(false);

      rerender({ open: true });
      expect(result.current.shouldRender).toBe(true);
      expect(result.current.isExiting).toBe(false);
    });
  });

  describe('cleanup', () => {
    it('clears the pending timer on unmount without errors', () => {
      const { rerender, unmount } = renderHook(
        ({ open }) => useExitAnimation(open, DURATION),
        { initialProps: { open: true } }
      );

      rerender({ open: false });
      unmount();

      // No setState-after-unmount warnings / crashes
      expect(() => {
        act(() => {
          vi.advanceTimersByTime(DURATION);
        });
      }).not.toThrow();
    });
  });
});
