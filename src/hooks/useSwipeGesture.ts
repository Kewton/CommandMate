/**
 * useSwipeGesture Hook
 *
 * Detects swipe gestures on touch devices
 */

'use client';

import { useRef, useState, useEffect, useCallback } from 'react';

/**
 * Swipe direction type
 */
export type SwipeDirection = 'left' | 'right' | 'up' | 'down';

/**
 * Options for useSwipeGesture hook
 */
export interface UseSwipeGestureOptions {
  /** Callback when swipe left is detected */
  onSwipeLeft?: () => void;
  /** Callback when swipe right is detected */
  onSwipeRight?: () => void;
  /** Callback when swipe up is detected */
  onSwipeUp?: () => void;
  /** Callback when swipe down is detected */
  onSwipeDown?: () => void;
  /** Minimum distance in pixels to trigger swipe (default: 50) */
  threshold?: number;
  /** Whether gesture detection is enabled (default: true) */
  enabled?: boolean;
}

/**
 * Return type for useSwipeGesture hook
 */
export interface UseSwipeGestureReturn {
  /** Ref to attach to the element */
  ref: React.RefObject<HTMLElement>;
  /** Whether user is currently swiping */
  isSwiping: boolean;
  /** Detected swipe direction (null if no swipe detected) */
  swipeDirection: SwipeDirection | null;
  /** Reset swipe direction to null */
  resetSwipeDirection: () => void;
}

/** Default swipe threshold in pixels */
const DEFAULT_THRESHOLD = 50;

/**
 * Check if an element is inside a scrollable container.
 * Used to suppress swipe gesture detection when the user is scrolling
 * within a scrollable element (e.g., preview pane, code editor).
 *
 * Issue #299: Prevents fullscreen exit when scrolling up in maximized editor.
 *
 * @param element - The target element to check
 * @returns true if the element is inside a vertically scrollable container
 */
export function isInsideScrollableElement(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const { overflowY } = getComputedStyle(current);
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      current.scrollHeight > current.clientHeight
    ) {
      return true;
    }
    current = current.parentElement;
  }
  return false;
}

/** Touch start coordinates type */
interface TouchPosition {
  x: number;
  y: number;
}

/**
 * Hook for detecting swipe gestures
 *
 * Attaches touch event listeners to the element and detects
 * swipe gestures in four directions.
 *
 * @param options - Configuration options
 * @returns Object containing ref, isSwiping state, and swipeDirection
 *
 * @example
 * ```tsx
 * const { ref, isSwiping, swipeDirection } = useSwipeGesture({
 *   onSwipeLeft: () => console.log('Swiped left'),
 *   onSwipeRight: () => console.log('Swiped right'),
 *   threshold: 100,
 * });
 *
 * return <div ref={ref}>Swipeable content</div>;
 * ```
 */
export function useSwipeGesture(options: UseSwipeGestureOptions = {}): UseSwipeGestureReturn {
  const {
    onSwipeLeft,
    onSwipeRight,
    onSwipeUp,
    onSwipeDown,
    threshold = DEFAULT_THRESHOLD,
    enabled = true,
  } = options;

  const ref = useRef<HTMLElement>(null);
  const [isSwiping, setIsSwiping] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<SwipeDirection | null>(null);

  // Touch start coordinates
  const touchStartRef = useRef<TouchPosition | null>(null);

  /**
   * Reset swipe direction to null
   */
  const resetSwipeDirection = useCallback(() => {
    setSwipeDirection(null);
  }, []);

  /**
   * Handle touch start
   */
  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled) return;

    // Issue #299: Suppress swipe detection inside scrollable elements
    // to prevent unintended fullscreen exit when scrolling content
    if (e.target instanceof HTMLElement && isInsideScrollableElement(e.target)) {
      touchStartRef.current = null;
      return;
    }

    const touch = e.touches[0];
    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    setIsSwiping(true);
  }, [enabled]);

  /**
   * Handle touch move
   */
  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (!enabled || !touchStartRef.current) return;

    // Track the current touch position for calculating direction
    const touch = e.touches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Determine current direction while swiping
    if (absX > absY && absX >= threshold) {
      setSwipeDirection(deltaX < 0 ? 'left' : 'right');
    } else if (absY >= threshold) {
      setSwipeDirection(deltaY < 0 ? 'up' : 'down');
    }
  }, [enabled, threshold]);

  /**
   * Handle touch end
   */
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!enabled || !touchStartRef.current) {
      setIsSwiping(false);
      return;
    }

    const touch = e.changedTouches[0];
    const deltaX = touch.clientX - touchStartRef.current.x;
    const deltaY = touch.clientY - touchStartRef.current.y;
    const absX = Math.abs(deltaX);
    const absY = Math.abs(deltaY);

    // Determine if horizontal or vertical swipe
    if (absX > absY) {
      // Horizontal swipe
      if (absX >= threshold) {
        if (deltaX < 0) {
          setSwipeDirection('left');
          onSwipeLeft?.();
        } else {
          setSwipeDirection('right');
          onSwipeRight?.();
        }
      }
    } else {
      // Vertical swipe
      if (absY >= threshold) {
        if (deltaY < 0) {
          setSwipeDirection('up');
          onSwipeUp?.();
        } else {
          setSwipeDirection('down');
          onSwipeDown?.();
        }
      }
    }

    // Reset state
    touchStartRef.current = null;
    setIsSwiping(false);
  }, [enabled, threshold, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown]);

  /**
   * Attach event listeners
   */
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.addEventListener('touchstart', handleTouchStart);
    element.addEventListener('touchmove', handleTouchMove);
    element.addEventListener('touchend', handleTouchEnd);

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return {
    ref,
    isSwiping,
    swipeDirection,
    resetSwipeDirection,
  };
}

export default useSwipeGesture;
