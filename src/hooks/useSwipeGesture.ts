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
 * Axis the gesture is constrained to.
 * Issue #1128: 'horizontal' powers tab switching (only left/right fire),
 * 'vertical' powers the bottom-sheet swipe-to-dismiss (only up/down fire),
 * 'both' preserves the original four-direction behaviour.
 */
export type SwipeAxis = 'horizontal' | 'vertical' | 'both';

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
  /**
   * Issue #1128: restrict which axis is considered. Default 'both'.
   * When set to 'horizontal'/'vertical', only that axis's callbacks fire and
   * the direction lock (below) defaults on so a perpendicular drag (e.g. a
   * vertical scroll under a horizontal tab-swipe) never triggers a swipe.
   */
  axis?: SwipeAxis;
  /**
   * Issue #1128: once the gesture's dominant direction is perpendicular to
   * `axis`, cancel it for the remainder of the touch (direction lock). This is
   * what keeps a vertical page scroll from firing a horizontal tab swipe.
   * Defaults to `true` when `axis` is 'horizontal'/'vertical', else `false`.
   */
  directionLock?: boolean;
  /**
   * Issue #1128: travel distance (px) at which the gesture commits to an axis
   * for the direction lock. Default 12.
   */
  directionLockThreshold?: number;
  /**
   * Issue #1128: suppress the gesture when the touch starts inside a scrollable
   * ancestor on the RELEVANT axis. For axis 'vertical'/'both' this checks
   * vertical scrollability (preserves the #299 fullscreen-exit behaviour); for
   * axis 'horizontal' it checks horizontal scrollability so a scrollable code /
   * terminal pane keeps its own horizontal scroll and text selection.
   * Default true.
   */
  suppressWhenScrollable?: boolean;
  /**
   * Issue #1128: when > 0, only start tracking a gesture if the touch begins
   * within this many pixels of the element's left or right edge. Used to make
   * tab-swipe conservative over the terminal pane (central taps/selections are
   * left untouched; only an intentional edge swipe changes tabs).
   */
  edgeStartZone?: number;
  /**
   * Issue #1128: live progress callback fired on every tracked touchmove after
   * suppression/direction-lock checks pass. Powers the bottom-sheet
   * finger-follow drag. Not called for suppressed or direction-locked gestures.
   */
  onSwipeMove?: (delta: { deltaX: number; deltaY: number }) => void;
  /**
   * Issue #1128: fired once at the end of a tracked gesture (touchend/cancel),
   * regardless of whether a swipe threshold was met. Lets consumers reset any
   * transient drag state (e.g. reset the sheet's translateY).
   */
  onSwipeEnd?: () => void;
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

/** Default direction-lock commit threshold in pixels (Issue #1128) */
const DEFAULT_DIRECTION_LOCK_THRESHOLD = 12;

/**
 * Check if an element is inside a scrollable container.
 * Used to suppress swipe gesture detection when the user is scrolling
 * within a scrollable element (e.g., preview pane, code editor).
 *
 * Issue #299: Prevents fullscreen exit when scrolling up in maximized editor.
 * Issue #1128: `axis` selects which overflow axis is inspected so a horizontal
 * tab-swipe suppresses on horizontally-scrollable ancestors while the original
 * vertical use cases keep checking vertical scrollability.
 *
 * @param element - The target element to check
 * @param axis - Which scroll axis to inspect (default 'vertical')
 * @returns true if the element is inside a scrollable container on that axis
 */
export function isInsideScrollableElement(
  element: HTMLElement,
  axis: 'vertical' | 'horizontal' = 'vertical'
): boolean {
  let current: HTMLElement | null = element;
  while (current) {
    const style = getComputedStyle(current);
    if (axis === 'horizontal') {
      const { overflowX } = style;
      if (
        (overflowX === 'auto' || overflowX === 'scroll') &&
        current.scrollWidth > current.clientWidth
      ) {
        return true;
      }
    } else {
      const { overflowY } = style;
      if (
        (overflowY === 'auto' || overflowY === 'scroll') &&
        current.scrollHeight > current.clientHeight
      ) {
        return true;
      }
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

/** Per-gesture direction-lock state (Issue #1128) */
interface GestureLockState {
  /** Axis the gesture has committed to, or null before commit */
  committed: 'horizontal' | 'vertical' | null;
  /** Whether the gesture has been cancelled by the direction lock */
  cancelled: boolean;
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
    axis = 'both',
    directionLock,
    directionLockThreshold = DEFAULT_DIRECTION_LOCK_THRESHOLD,
    suppressWhenScrollable = true,
    edgeStartZone = 0,
    onSwipeMove,
    onSwipeEnd,
  } = options;

  // Direction lock defaults on whenever the gesture is constrained to one axis.
  const lockEnabled = directionLock ?? axis !== 'both';
  // Axis inspected for scroll-container suppression.
  const suppressionAxis = axis === 'horizontal' ? 'horizontal' : 'vertical';
  const allowHorizontal = axis === 'both' || axis === 'horizontal';
  const allowVertical = axis === 'both' || axis === 'vertical';

  const ref = useRef<HTMLElement>(null);
  const [isSwiping, setIsSwiping] = useState(false);
  const [swipeDirection, setSwipeDirection] = useState<SwipeDirection | null>(null);

  // Touch start coordinates
  const touchStartRef = useRef<TouchPosition | null>(null);
  // Direction-lock bookkeeping for the in-flight gesture.
  const lockRef = useRef<GestureLockState | null>(null);

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

    // Issue #299 / #1128: Suppress swipe detection inside scrollable elements
    // (on the relevant axis) to preserve native scrolling and text selection.
    if (
      suppressWhenScrollable &&
      e.target instanceof HTMLElement &&
      isInsideScrollableElement(e.target, suppressionAxis)
    ) {
      touchStartRef.current = null;
      return;
    }

    const touch = e.touches[0];

    // Issue #1128: edge-start restriction (conservative tab-swipe over terminal).
    if (edgeStartZone > 0 && ref.current) {
      const rect = ref.current.getBoundingClientRect();
      const fromLeft = touch.clientX - rect.left;
      const fromRight = rect.right - touch.clientX;
      if (fromLeft > edgeStartZone && fromRight > edgeStartZone) {
        touchStartRef.current = null;
        return;
      }
    }

    touchStartRef.current = { x: touch.clientX, y: touch.clientY };
    lockRef.current = { committed: null, cancelled: false };
    setIsSwiping(true);
  }, [enabled, suppressWhenScrollable, suppressionAxis, edgeStartZone]);

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

    // Issue #1128: direction lock. Once the dominant axis is decided, a gesture
    // perpendicular to `axis` is cancelled so it can never fire a swipe.
    if (lockEnabled) {
      const lock = lockRef.current;
      if (lock) {
        if (lock.cancelled) return;
        if (lock.committed === null && Math.max(absX, absY) >= directionLockThreshold) {
          const dominant = absX > absY ? 'horizontal' : 'vertical';
          lock.committed = dominant;
          if (dominant !== axis) {
            lock.cancelled = true;
            return;
          }
        }
        if (lock.committed !== null && lock.committed !== axis) return;
      }
    }

    // Determine current direction while swiping
    if (allowHorizontal && absX > absY && absX >= threshold) {
      setSwipeDirection(deltaX < 0 ? 'left' : 'right');
    } else if (allowVertical && absY >= threshold) {
      setSwipeDirection(deltaY < 0 ? 'up' : 'down');
    }

    onSwipeMove?.({ deltaX, deltaY });
  }, [enabled, threshold, axis, lockEnabled, directionLockThreshold, allowHorizontal, allowVertical, onSwipeMove]);

  /**
   * Handle touch end
   */
  const handleTouchEnd = useCallback((e: TouchEvent) => {
    if (!enabled || !touchStartRef.current) {
      setIsSwiping(false);
      return;
    }

    const cancelled = lockEnabled && lockRef.current?.cancelled === true;
    const touch = e.changedTouches[0];

    if (!cancelled && touch) {
      const deltaX = touch.clientX - touchStartRef.current.x;
      const deltaY = touch.clientY - touchStartRef.current.y;
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);

      // Determine if horizontal or vertical swipe
      if (absX > absY) {
        // Horizontal swipe
        if (allowHorizontal && absX >= threshold) {
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
        if (allowVertical && absY >= threshold) {
          if (deltaY < 0) {
            setSwipeDirection('up');
            onSwipeUp?.();
          } else {
            setSwipeDirection('down');
            onSwipeDown?.();
          }
        }
      }
    }

    // Reset state
    touchStartRef.current = null;
    lockRef.current = null;
    setIsSwiping(false);
    onSwipeEnd?.();
  }, [enabled, threshold, lockEnabled, allowHorizontal, allowVertical, onSwipeLeft, onSwipeRight, onSwipeUp, onSwipeDown, onSwipeEnd]);

  /**
   * Handle touch cancel (Issue #1128): treat like an end with no swipe so
   * transient drag state is always reset.
   */
  const handleTouchCancel = useCallback(() => {
    if (!touchStartRef.current) return;
    touchStartRef.current = null;
    lockRef.current = null;
    setIsSwiping(false);
    onSwipeEnd?.();
  }, [onSwipeEnd]);

  /**
   * Attach event listeners
   */
  useEffect(() => {
    const element = ref.current;
    if (!element) return;

    element.addEventListener('touchstart', handleTouchStart);
    element.addEventListener('touchmove', handleTouchMove);
    element.addEventListener('touchend', handleTouchEnd);
    element.addEventListener('touchcancel', handleTouchCancel);

    return () => {
      element.removeEventListener('touchstart', handleTouchStart);
      element.removeEventListener('touchmove', handleTouchMove);
      element.removeEventListener('touchend', handleTouchEnd);
      element.removeEventListener('touchcancel', handleTouchCancel);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd, handleTouchCancel]);

  return {
    ref,
    isSwiping,
    swipeDirection,
    resetSwipeDirection,
  };
}

export default useSwipeGesture;
