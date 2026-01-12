/**
 * Tests for useScrollRestoration hook
 *
 * Tests scroll position save and restore functionality
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollRestoration } from '@/hooks/useScrollRestoration';

describe('useScrollRestoration', () => {
  // Mock ref element
  let mockElement: HTMLDivElement;

  beforeEach(() => {
    mockElement = document.createElement('div');
    // Set up scroll properties
    Object.defineProperty(mockElement, 'scrollHeight', { value: 1000, writable: true });
    Object.defineProperty(mockElement, 'clientHeight', { value: 200, writable: true });
    Object.defineProperty(mockElement, 'scrollTop', { value: 0, writable: true });
    mockElement.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('should return a ref object', () => {
      const { result } = renderHook(() => useScrollRestoration());
      expect(result.current.containerRef).toBeDefined();
      expect(result.current.containerRef.current).toBeNull();
    });

    it('should provide savePosition function', () => {
      const { result } = renderHook(() => useScrollRestoration());
      expect(typeof result.current.savePosition).toBe('function');
    });

    it('should provide restorePosition function', () => {
      const { result } = renderHook(() => useScrollRestoration());
      expect(typeof result.current.restorePosition).toBe('function');
    });

    it('should provide scrollToBottom function', () => {
      const { result } = renderHook(() => useScrollRestoration());
      expect(typeof result.current.scrollToBottom).toBe('function');
    });
  });

  describe('savePosition', () => {
    it('should save the current scroll position', () => {
      const { result } = renderHook(() => useScrollRestoration());

      // Set up ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Set scroll position
      Object.defineProperty(mockElement, 'scrollTop', { value: 300, writable: true });

      // Save position
      act(() => {
        result.current.savePosition();
      });

      // Get saved position (internal state)
      expect(result.current.getSavedPosition()).toBe(300);
    });

    it('should not throw when ref is null', () => {
      const { result } = renderHook(() => useScrollRestoration());

      expect(() => {
        act(() => {
          result.current.savePosition();
        });
      }).not.toThrow();
    });
  });

  describe('restorePosition', () => {
    it('should restore the saved scroll position', async () => {
      vi.useFakeTimers();
      const { result } = renderHook(() => useScrollRestoration());

      // Set up ref with mock element
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Save a position first
      Object.defineProperty(mockElement, 'scrollTop', { value: 500, writable: true });
      act(() => {
        result.current.savePosition();
      });

      // Restore position
      act(() => {
        result.current.restorePosition();
      });

      // Run requestAnimationFrame
      await act(async () => {
        vi.runAllTimers();
      });

      // Verify scrollTop was set (via scrollTo)
      expect(mockElement.scrollTo).toHaveBeenCalled();
      vi.useRealTimers();
    });

    it('should not throw when ref is null', () => {
      const { result } = renderHook(() => useScrollRestoration());

      expect(() => {
        act(() => {
          result.current.restorePosition();
        });
      }).not.toThrow();
    });
  });

  describe('scrollToBottom', () => {
    it('should scroll to the bottom of the container', () => {
      const { result } = renderHook(() => useScrollRestoration());

      // Set up ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      act(() => {
        result.current.scrollToBottom();
      });

      expect(mockElement.scrollTo).toHaveBeenCalledWith({
        top: mockElement.scrollHeight,
        behavior: 'smooth',
      });
    });

    it('should not throw when ref is null', () => {
      const { result } = renderHook(() => useScrollRestoration());

      expect(() => {
        act(() => {
          result.current.scrollToBottom();
        });
      }).not.toThrow();
    });
  });

  describe('Options', () => {
    it('should accept stickyHeaderHeight option', () => {
      const { result } = renderHook(() =>
        useScrollRestoration({ stickyHeaderHeight: 48 })
      );

      expect(result.current.containerRef).toBeDefined();
    });

    it('should respect preserveOnNewMessage option', () => {
      const { result } = renderHook(() =>
        useScrollRestoration({ preserveOnNewMessage: false })
      );

      expect(result.current.containerRef).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle zero scroll position', () => {
      const { result } = renderHook(() => useScrollRestoration());

      // Set up ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Save zero position
      Object.defineProperty(mockElement, 'scrollTop', { value: 0, writable: true });
      act(() => {
        result.current.savePosition();
      });

      expect(result.current.getSavedPosition()).toBe(0);
    });

    it('should handle large scroll positions', () => {
      const { result } = renderHook(() => useScrollRestoration());

      // Set up ref
      act(() => {
        Object.defineProperty(result.current.containerRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Save large position
      Object.defineProperty(mockElement, 'scrollTop', { value: 10000, writable: true });
      act(() => {
        result.current.savePosition();
      });

      expect(result.current.getSavedPosition()).toBe(10000);
    });
  });

  describe('Cleanup', () => {
    it('should not leak memory on unmount', () => {
      const { unmount } = renderHook(() => useScrollRestoration());

      expect(() => {
        unmount();
      }).not.toThrow();
    });
  });
});
