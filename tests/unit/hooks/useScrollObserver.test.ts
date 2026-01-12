/**
 * Tests for useScrollObserver hook
 *
 * Tests scroll position detection and callback triggering
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollObserver } from '@/hooks/useScrollObserver';

describe('useScrollObserver', () => {
  // Mock ref element
  let mockElement: HTMLDivElement;

  beforeEach(() => {
    mockElement = document.createElement('div');
    // Set up scroll properties: total height 1000, visible 200
    Object.defineProperty(mockElement, 'scrollHeight', { value: 1000, writable: true });
    Object.defineProperty(mockElement, 'clientHeight', { value: 200, writable: true });
    Object.defineProperty(mockElement, 'scrollTop', { value: 0, writable: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('should return a ref object', () => {
      const { result } = renderHook(() => useScrollObserver({}));
      expect(result.current.containerRef).toBeDefined();
      expect(result.current.containerRef.current).toBeNull();
    });

    it('should return handleScroll function', () => {
      const { result } = renderHook(() => useScrollObserver({}));
      expect(typeof result.current.handleScroll).toBe('function');
    });
  });

  describe('onNearTop callback', () => {
    it('should call onNearTop when scroll position is near top', () => {
      const onNearTop = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearTop, threshold: 100 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Simulate scroll to near top (within threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 50, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).toHaveBeenCalled();
    });

    it('should not call onNearTop when scroll position is far from top', () => {
      const onNearTop = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearTop, threshold: 100 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Simulate scroll to middle (outside threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 400, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).not.toHaveBeenCalled();
    });
  });

  describe('onNearBottom callback', () => {
    it('should call onNearBottom when scroll position is near bottom', () => {
      const onNearBottom = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearBottom, threshold: 100 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Simulate scroll to near bottom
      // bottom = scrollHeight - clientHeight = 1000 - 200 = 800
      // Near bottom = 800 - threshold = 700+
      Object.defineProperty(mockElement, 'scrollTop', { value: 750, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearBottom).toHaveBeenCalled();
    });

    it('should not call onNearBottom when scroll position is far from bottom', () => {
      const onNearBottom = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearBottom, threshold: 100 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Simulate scroll to middle (outside threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 400, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearBottom).not.toHaveBeenCalled();
    });
  });

  describe('Threshold configuration', () => {
    it('should use default threshold of 100px', () => {
      const onNearTop = vi.fn();
      const { result } = renderHook(() => useScrollObserver({ onNearTop }));

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Scroll to 99px (within default 100px threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 99, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).toHaveBeenCalled();
    });

    it('should respect custom threshold', () => {
      const onNearTop = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearTop, threshold: 50 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Scroll to 60px (outside 50px threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 60, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).not.toHaveBeenCalled();

      // Scroll to 40px (within 50px threshold)
      Object.defineProperty(mockElement, 'scrollTop', { value: 40, writable: true });

      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).toHaveBeenCalled();
    });
  });

  describe('Debounce behavior', () => {
    it('should not call callback multiple times within debounce period', () => {
      vi.useFakeTimers();
      const onNearTop = vi.fn();
      const { result } = renderHook(() =>
        useScrollObserver({ onNearTop, threshold: 100, debounceMs: 200 })
      );

      // Set ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Scroll to near top
      Object.defineProperty(mockElement, 'scrollTop', { value: 50, writable: true });

      // Call handleScroll multiple times quickly
      act(() => {
        result.current.handleScroll();
        result.current.handleScroll();
        result.current.handleScroll();
      });

      // Should only call once due to debounce
      expect(onNearTop).toHaveBeenCalledTimes(1);

      // Wait for debounce period
      act(() => {
        vi.advanceTimersByTime(200);
      });

      // Call again after debounce
      act(() => {
        result.current.handleScroll();
      });

      expect(onNearTop).toHaveBeenCalledTimes(2);

      vi.useRealTimers();
    });
  });

  describe('Edge cases', () => {
    it('should handle null container ref gracefully', () => {
      const onNearTop = vi.fn();
      const { result } = renderHook(() => useScrollObserver({ onNearTop }));

      // Don't set ref, call handleScroll
      expect(() => {
        act(() => {
          result.current.handleScroll();
        });
      }).not.toThrow();

      expect(onNearTop).not.toHaveBeenCalled();
    });

    it('should handle zero scrollHeight', () => {
      const onNearBottom = vi.fn();
      const { result } = renderHook(() => useScrollObserver({ onNearBottom }));

      // Set ref with zero scrollHeight
      Object.defineProperty(mockElement, 'scrollHeight', { value: 0, writable: true });
      Object.defineProperty(mockElement, 'clientHeight', { value: 0, writable: true });

      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      expect(() => {
        act(() => {
          result.current.handleScroll();
        });
      }).not.toThrow();
    });

    it('should handle both onNearTop and onNearBottom being undefined', () => {
      const { result } = renderHook(() => useScrollObserver({}));

      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      expect(() => {
        act(() => {
          result.current.handleScroll();
        });
      }).not.toThrow();
    });
  });

  describe('Cleanup', () => {
    it('should not leak memory on unmount', () => {
      const onNearTop = vi.fn();
      const { unmount } = renderHook(() =>
        useScrollObserver({ onNearTop })
      );

      expect(() => {
        unmount();
      }).not.toThrow();
    });
  });
});
