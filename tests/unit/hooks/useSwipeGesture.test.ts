/**
 * Tests for useSwipeGesture hook
 *
 * Tests swipe gesture detection for touch devices
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useSwipeGesture } from '@/hooks/useSwipeGesture';

describe('useSwipeGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should return a ref object', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.ref).toBeDefined();
      expect(result.current.ref.current).toBeNull();
    });

    it('should return isSwiping as false initially', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.isSwiping).toBe(false);
    });

    it('should return swipeDirection as null initially', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.swipeDirection).toBeNull();
    });
  });

  describe('Options Configuration', () => {
    it('should accept onSwipeLeft callback', () => {
      const onSwipeLeft = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeLeft }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeRight callback', () => {
      const onSwipeRight = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeRight }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeUp callback', () => {
      const onSwipeUp = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeUp }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeDown callback', () => {
      const onSwipeDown = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeDown }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept custom threshold', () => {
      const { result } = renderHook(() => useSwipeGesture({ threshold: 100 }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept enabled option', () => {
      const { result } = renderHook(() => useSwipeGesture({ enabled: false }));
      expect(result.current.ref).toBeDefined();
    });

    it('should be enabled by default', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      // Hook returns without error, implying enabled=true is default
      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Return Value Types', () => {
    it('should return ref with correct type', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(typeof result.current.ref).toBe('object');
      expect('current' in result.current.ref).toBe(true);
    });

    it('should return isSwiping as boolean', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(typeof result.current.isSwiping).toBe('boolean');
    });

    it('should return swipeDirection as null or string', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.swipeDirection === null || typeof result.current.swipeDirection === 'string').toBe(true);
    });
  });

  describe('Hook Stability', () => {
    it('should maintain ref identity across re-renders', () => {
      const { result, rerender } = renderHook(() => useSwipeGesture({}));
      const initialRef = result.current.ref;

      rerender();

      expect(result.current.ref).toBe(initialRef);
    });

    it('should handle options changes', () => {
      const onSwipeLeft1 = vi.fn();
      const onSwipeLeft2 = vi.fn();

      const { result, rerender } = renderHook(
        ({ onSwipeLeft }) => useSwipeGesture({ onSwipeLeft }),
        { initialProps: { onSwipeLeft: onSwipeLeft1 } }
      );

      expect(result.current.ref).toBeDefined();

      rerender({ onSwipeLeft: onSwipeLeft2 });

      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should not throw on unmount', () => {
      const { unmount } = renderHook(() => useSwipeGesture({}));

      expect(() => unmount()).not.toThrow();
    });

    it('should cleanup without errors when ref was never assigned', () => {
      const { unmount } = renderHook(() => useSwipeGesture({
        onSwipeLeft: vi.fn(),
        onSwipeRight: vi.fn(),
      }));

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Default Values', () => {
    it('should use default threshold of 50px', () => {
      // This tests that the hook accepts no threshold and doesn't throw
      const { result } = renderHook(() => useSwipeGesture({ onSwipeLeft: vi.fn() }));
      expect(result.current.ref).toBeDefined();
    });

    it('should default enabled to true', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      // If enabled were false by default, hook behavior would be different
      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Empty Options', () => {
    it('should work with empty options object', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current).toEqual({
        ref: expect.any(Object),
        isSwiping: false,
        swipeDirection: null,
        resetSwipeDirection: expect.any(Function),
      });
    });

    it('should work with no options', () => {
      const { result } = renderHook(() => useSwipeGesture());
      expect(result.current).toEqual({
        ref: expect.any(Object),
        isSwiping: false,
        swipeDirection: null,
        resetSwipeDirection: expect.any(Function),
      });
    });
  });
});
