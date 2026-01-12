/**
 * useScrollRestoration Hook
 *
 * Provides scroll position save and restore functionality for containers.
 * Useful for preserving scroll position when content updates or when
 * navigating between views.
 *
 * Features:
 * - Save current scroll position
 * - Restore saved scroll position (with requestAnimationFrame for smooth transition)
 * - Scroll to bottom functionality
 * - Optional sticky header height consideration
 * - Optional preserve on new message flag
 */

import { useRef, useCallback } from 'react';

/**
 * Options for useScrollRestoration hook
 */
export interface ScrollRestorationOptions {
  /** Height of sticky header to account for in calculations (default: 0) */
  stickyHeaderHeight?: number;
  /** Whether to preserve scroll position when new messages arrive (default: true) */
  preserveOnNewMessage?: boolean;
}

/**
 * Return type for useScrollRestoration hook
 */
export interface UseScrollRestorationReturn {
  /** Ref to attach to the scroll container */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Save the current scroll position */
  savePosition: () => void;
  /** Restore the saved scroll position */
  restorePosition: () => void;
  /** Scroll to the bottom of the container */
  scrollToBottom: () => void;
  /** Get the currently saved position (for testing/debugging) */
  getSavedPosition: () => number;
}

/**
 * Hook for managing scroll position save/restore in a container
 *
 * @param options - Configuration options
 * @returns Object with containerRef and scroll management functions
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { containerRef, savePosition, restorePosition, scrollToBottom } = useScrollRestoration({
 *     stickyHeaderHeight: 48,
 *   });
 *
 *   return (
 *     <div ref={containerRef} className="overflow-y-auto">
 *       {content}
 *     </div>
 *   );
 * }
 * ```
 */
export function useScrollRestoration(
  options: ScrollRestorationOptions = {}
): UseScrollRestorationReturn {
  // Destructure options with defaults
  // Note: stickyHeaderHeight and preserveOnNewMessage are kept for future enhancements
  // Currently, sticky top-0 doesn't affect scrollTop calculation
  const { stickyHeaderHeight: _stickyHeaderHeight = 0, preserveOnNewMessage: _preserveOnNewMessage = true } = options;
  void _stickyHeaderHeight;
  void _preserveOnNewMessage;

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const savedPositionRef = useRef<number>(0);

  /**
   * Save the current scroll position
   */
  const savePosition = useCallback(() => {
    const container = containerRef.current;
    if (container) {
      savedPositionRef.current = container.scrollTop;
    }
  }, []);

  /**
   * Restore the saved scroll position
   * Uses requestAnimationFrame for smooth transition
   */
  const restorePosition = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const savedPosition = savedPositionRef.current;

    requestAnimationFrame(() => {
      if (containerRef.current) {
        containerRef.current.scrollTo({
          top: savedPosition,
          behavior: 'auto',
        });
      }
    });
  }, []);

  /**
   * Scroll to the bottom of the container
   */
  const scrollToBottom = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    container.scrollTo({
      top: container.scrollHeight,
      behavior: 'smooth',
    });
  }, []);

  /**
   * Get the currently saved position (for testing/debugging)
   */
  const getSavedPosition = useCallback(() => {
    return savedPositionRef.current;
  }, []);

  return {
    containerRef,
    savePosition,
    restorePosition,
    scrollToBottom,
    getSavedPosition,
  };
}

export default useScrollRestoration;
