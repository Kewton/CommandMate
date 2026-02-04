/**
 * useLongPress Hook
 *
 * Detects long press gestures for touch devices (iPad/iPhone).
 * Provides touch event handlers for implementing context menu on long press.
 *
 * Features:
 * - Configurable long press delay (default: 500ms)
 * - Movement threshold cancellation (default: 10px)
 * - Multi-touch prevention
 * - Proper cleanup on unmount
 *
 * @module hooks/useLongPress
 * @see Issue #123 - iPad touch context menu support
 * @see PaneResizer.tsx - Reference implementation for touch coordinate handling
 */

'use client';

import { useRef, useCallback, useEffect } from 'react';

// ============================================================================
// Constants
// ============================================================================

/** Long press detection time in milliseconds */
export const LONG_PRESS_DELAY = 500;

/** Movement threshold in pixels - cancel if touch moves beyond this */
export const MOVE_THRESHOLD = 10;

// ============================================================================
// Types
// ============================================================================

/**
 * Options for useLongPress hook
 */
export interface UseLongPressOptions {
  /** Long press detection time in ms (default: 500) */
  delay?: number;
  /** Movement threshold in px - cancel if exceeded (default: 10) */
  moveThreshold?: number;
  /** Callback when long press is detected */
  onLongPress: (e: React.TouchEvent) => void;
}

/**
 * Return type for useLongPress hook
 */
export interface UseLongPressReturn {
  /** Handler for touchstart event */
  onTouchStart: (e: React.TouchEvent) => void;
  /** Handler for touchmove event */
  onTouchMove: (e: React.TouchEvent) => void;
  /** Handler for touchend event */
  onTouchEnd: () => void;
  /** Handler for touchcancel event */
  onTouchCancel: () => void;
}

// ============================================================================
// Hook Implementation
// ============================================================================

/**
 * Custom hook for detecting long press gestures on touch devices.
 *
 * Implements the long press pattern for iPad/iPhone context menus:
 * - Starts timer on touchstart (single finger only)
 * - Cancels if touch moves beyond threshold
 * - Cancels on touchend/touchcancel
 * - Fires callback after delay
 *
 * @param options - Configuration options
 * @returns Touch event handlers to spread onto target element
 *
 * @example
 * ```tsx
 * const longPressHandlers = useLongPress({
 *   onLongPress: (e) => openContextMenu(e),
 *   delay: 500,
 *   moveThreshold: 10,
 * });
 *
 * return (
 *   <div {...longPressHandlers}>
 *     Long press me
 *   </div>
 * );
 * ```
 */
export function useLongPress({
  delay = LONG_PRESS_DELAY,
  moveThreshold = MOVE_THRESHOLD,
  onLongPress,
}: UseLongPressOptions): UseLongPressReturn {
  // Timer reference for cleanup
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Start position for movement detection
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  // Store touch event reference for callback
  // Note: React 17+ doesn't use event pooling, but we store reference for safety
  // and to ensure the callback receives the original event
  const touchEventRef = useRef<React.TouchEvent | null>(null);

  /**
   * Clear timer and reset state
   */
  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
    touchEventRef.current = null;
  }, []);

  /**
   * Cleanup on unmount
   */
  useEffect(() => {
    return () => clearTimer();
  }, [clearTimer]);

  /**
   * Handle touch start - begin long press timer
   */
  const onTouchStart = useCallback(
    (e: React.TouchEvent) => {
      // Only handle single touch (ignore multi-touch gestures)
      if (e.touches.length !== 1) return;

      const touch = e.touches[0];
      startPosRef.current = { x: touch.clientX, y: touch.clientY };
      touchEventRef.current = e;

      timerRef.current = setTimeout(() => {
        if (touchEventRef.current) {
          onLongPress(touchEventRef.current);
        }
        clearTimer();
      }, delay);
    },
    [delay, onLongPress, clearTimer]
  );

  /**
   * Handle touch move - cancel if moved beyond threshold
   */
  const onTouchMove = useCallback(
    (e: React.TouchEvent) => {
      // Ignore multi-touch move events
      if (!startPosRef.current || e.touches.length !== 1) return;

      const touch = e.touches[0];
      const dx = touch.clientX - startPosRef.current.x;
      const dy = touch.clientY - startPosRef.current.y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      // Cancel if moved beyond threshold
      if (distance > moveThreshold) {
        clearTimer();
      }
    },
    [moveThreshold, clearTimer]
  );

  /**
   * Handle touch end - cancel timer
   */
  const onTouchEnd = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  /**
   * Handle touch cancel - cancel timer
   * Triggered by system interruptions (notifications, calls, etc.)
   */
  const onTouchCancel = useCallback(() => {
    clearTimer();
  }, [clearTimer]);

  return {
    onTouchStart,
    onTouchMove,
    onTouchEnd,
    onTouchCancel,
  };
}
