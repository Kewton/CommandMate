/**
 * Tests for useIsMobile hook
 *
 * Tests mobile detection based on window width
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile, MOBILE_BREAKPOINT } from '@/hooks/useIsMobile';

describe('useIsMobile', () => {
  // Store original innerWidth
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
  });

  afterEach(() => {
    // Restore original width
    Object.defineProperty(window, 'innerWidth', {
      value: originalInnerWidth,
      writable: true,
    });
    vi.clearAllMocks();
  });

  /**
   * Helper to set window width
   */
  function setWindowWidth(width: number) {
    Object.defineProperty(window, 'innerWidth', {
      value: width,
      writable: true,
    });
  }

  /**
   * Helper to trigger resize event
   */
  function triggerResize() {
    window.dispatchEvent(new Event('resize'));
  }

  describe('Initial state', () => {
    it('should return true when window width is less than breakpoint', () => {
      setWindowWidth(500);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);
    });

    it('should return false when window width is greater than or equal to breakpoint', () => {
      setWindowWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
    });

    it('should return false when window width equals breakpoint exactly', () => {
      setWindowWidth(MOBILE_BREAKPOINT);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
    });

    it('should return true when window width is just below breakpoint', () => {
      setWindowWidth(MOBILE_BREAKPOINT - 1);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);
    });
  });

  describe('Resize handling', () => {
    it('should update when window is resized to mobile width', () => {
      // Start with desktop width
      setWindowWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);

      // Resize to mobile
      act(() => {
        setWindowWidth(500);
        triggerResize();
      });

      expect(result.current).toBe(true);
    });

    it('should update when window is resized to desktop width', () => {
      // Start with mobile width
      setWindowWidth(500);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);

      // Resize to desktop
      act(() => {
        setWindowWidth(1024);
        triggerResize();
      });

      expect(result.current).toBe(false);
    });

    it('should not change state when staying within mobile range', () => {
      // Start with mobile width
      setWindowWidth(400);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);

      // Resize but stay mobile
      act(() => {
        setWindowWidth(600);
        triggerResize();
      });

      expect(result.current).toBe(true);
    });

    it('should not change state when staying within desktop range', () => {
      // Start with desktop width
      setWindowWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);

      // Resize but stay desktop
      act(() => {
        setWindowWidth(1200);
        triggerResize();
      });

      expect(result.current).toBe(false);
    });
  });

  describe('Cleanup', () => {
    it('should remove resize listener on unmount', () => {
      const removeEventListenerSpy = vi.spyOn(window, 'removeEventListener');

      setWindowWidth(1024);
      const { unmount } = renderHook(() => useIsMobile());

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith(
        'resize',
        expect.any(Function)
      );

      removeEventListenerSpy.mockRestore();
    });
  });

  describe('Breakpoint value', () => {
    it('should use 768 as the default breakpoint', () => {
      expect(MOBILE_BREAKPOINT).toBe(768);
    });
  });

  describe('Custom breakpoint', () => {
    it('should accept custom breakpoint', () => {
      setWindowWidth(900);
      const { result } = renderHook(() => useIsMobile({ breakpoint: 1024 }));
      expect(result.current).toBe(true);
    });

    it('should work correctly with custom breakpoint on resize', () => {
      setWindowWidth(900);
      const { result } = renderHook(() => useIsMobile({ breakpoint: 1024 }));
      expect(result.current).toBe(true);

      act(() => {
        setWindowWidth(1100);
        triggerResize();
      });

      expect(result.current).toBe(false);
    });
  });
});
