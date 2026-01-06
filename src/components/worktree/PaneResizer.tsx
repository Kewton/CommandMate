/**
 * PaneResizer Component
 *
 * Draggable resizer for adjusting pane widths.
 * Supports both horizontal and vertical orientations.
 * Includes keyboard and touch support for accessibility.
 */

'use client';

import React, { useState, useCallback, useEffect, useRef, useMemo, memo } from 'react';

// ============================================================================
// Types
// ============================================================================

/** Resizer orientation type */
export type ResizerOrientation = 'horizontal' | 'vertical';

/**
 * Props for PaneResizer component
 */
export interface PaneResizerProps {
  /** Callback when resize occurs, receives delta in pixels */
  onResize: (delta: number) => void;
  /** Orientation of the resizer */
  orientation?: ResizerOrientation;
  /** Current position value for aria-valuenow (percentage) */
  ariaValueNow?: number;
}

// ============================================================================
// Constants
// ============================================================================

/** Keyboard step size in pixels for arrow key navigation */
const KEYBOARD_STEP = 10;

/** Base classes shared by all resizer states */
const BASE_CLASSES = [
  'flex-shrink-0',
  'bg-gray-700',
  'transition-colors',
  'duration-150',
  'hover:bg-blue-500',
  'focus:outline-none',
  'focus:ring-2',
  'focus:ring-blue-500',
  'focus:ring-offset-2',
  'focus:ring-offset-gray-900',
] as const;

/** Classes for horizontal orientation */
const HORIZONTAL_CLASSES = ['w-1', 'h-full', 'cursor-col-resize', 'hover:w-2'] as const;

/** Classes for vertical orientation */
const VERTICAL_CLASSES = ['h-1', 'w-full', 'cursor-row-resize', 'hover:h-2'] as const;

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Gets the position from a mouse or touch event based on orientation
 */
function getPosition(
  e: MouseEvent | React.MouseEvent | TouchEvent | React.TouchEvent,
  isHorizontal: boolean
): number {
  if ('touches' in e && e.touches.length > 0) {
    return isHorizontal ? e.touches[0].clientX : e.touches[0].clientY;
  }
  if ('clientX' in e) {
    return isHorizontal ? e.clientX : e.clientY;
  }
  return 0;
}

// ============================================================================
// Main Component
// ============================================================================

/**
 * PaneResizer component for adjusting pane sizes.
 *
 * Features:
 * - Mouse drag support
 * - Touch support for mobile devices
 * - Keyboard navigation (Arrow keys)
 * - Full accessibility with ARIA attributes
 *
 * @example
 * ```tsx
 * <PaneResizer
 *   onResize={(delta) => setWidth(prev => prev + delta)}
 *   orientation="horizontal"
 * />
 * ```
 */
export const PaneResizer = memo(function PaneResizer({
  onResize,
  orientation = 'horizontal',
  ariaValueNow = 50,
}: PaneResizerProps) {
  const [isDragging, setIsDragging] = useState(false);
  const startPositionRef = useRef<number>(0);
  const resizerRef = useRef<HTMLDivElement>(null);

  // Determine if horizontal or vertical
  const isHorizontal = orientation === 'horizontal';

  /**
   * Handle mouse down - start dragging
   */
  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      setIsDragging(true);
      startPositionRef.current = getPosition(e, isHorizontal);
    },
    [isHorizontal]
  );

  /**
   * Handle touch start - start dragging (mobile support)
   */
  const handleTouchStart = useCallback(
    (e: React.TouchEvent) => {
      if (e.touches.length === 1) {
        setIsDragging(true);
        startPositionRef.current = getPosition(e, isHorizontal);
      }
    },
    [isHorizontal]
  );

  /**
   * Handle mouse move - update position
   */
  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isDragging) return;

      const currentPosition = getPosition(e, isHorizontal);
      const delta = currentPosition - startPositionRef.current;
      onResize(delta);
      startPositionRef.current = currentPosition;
    },
    [isDragging, isHorizontal, onResize]
  );

  /**
   * Handle touch move - update position (mobile support)
   */
  const handleTouchMove = useCallback(
    (e: TouchEvent) => {
      if (!isDragging || e.touches.length !== 1) return;

      const currentPosition = getPosition(e, isHorizontal);
      const delta = currentPosition - startPositionRef.current;
      onResize(delta);
      startPositionRef.current = currentPosition;
    },
    [isDragging, isHorizontal, onResize]
  );

  /**
   * Handle mouse/touch up - stop dragging
   */
  const handleDragEnd = useCallback(() => {
    setIsDragging(false);
  }, []);

  /**
   * Handle keyboard navigation for accessibility
   */
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let delta = 0;

      if (isHorizontal) {
        if (e.key === 'ArrowRight') {
          delta = KEYBOARD_STEP;
        } else if (e.key === 'ArrowLeft') {
          delta = -KEYBOARD_STEP;
        }
      } else {
        if (e.key === 'ArrowDown') {
          delta = KEYBOARD_STEP;
        } else if (e.key === 'ArrowUp') {
          delta = -KEYBOARD_STEP;
        }
      }

      if (delta !== 0) {
        e.preventDefault();
        onResize(delta);
      }
    },
    [isHorizontal, onResize]
  );

  // Add/remove event listeners for drag
  useEffect(() => {
    if (isDragging) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleDragEnd);
      document.addEventListener('touchmove', handleTouchMove);
      document.addEventListener('touchend', handleDragEnd);

      // Prevent text selection during drag
      document.body.style.userSelect = 'none';
      document.body.style.cursor = isHorizontal ? 'col-resize' : 'row-resize';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleDragEnd);
      document.removeEventListener('touchmove', handleTouchMove);
      document.removeEventListener('touchend', handleDragEnd);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
  }, [isDragging, handleMouseMove, handleDragEnd, handleTouchMove, isHorizontal]);

  // Build class names with memoization for performance
  const className = useMemo(() => {
    const orientationClasses = isHorizontal ? HORIZONTAL_CLASSES : VERTICAL_CLASSES;
    const draggingClasses = isDragging
      ? ['bg-blue-500', 'dragging', isHorizontal ? 'w-2' : 'h-2']
      : [];

    return [...BASE_CLASSES, ...orientationClasses, ...draggingClasses].join(' ');
  }, [isHorizontal, isDragging]);

  return (
    <div
      ref={resizerRef}
      role="separator"
      aria-orientation={orientation}
      aria-valuenow={ariaValueNow}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-label={`Resize panes. Use ${isHorizontal ? 'left and right' : 'up and down'} arrow keys to adjust.`}
      tabIndex={0}
      className={className}
      onMouseDown={handleMouseDown}
      onTouchStart={handleTouchStart}
      onKeyDown={handleKeyDown}
    />
  );
});

export default PaneResizer;
