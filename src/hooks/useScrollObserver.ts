/**
 * useScrollObserver Hook
 *
 * Observes scroll position in a container and triggers callbacks
 * when the scroll position is near the top or bottom.
 *
 * Features:
 * - Configurable threshold for triggering callbacks
 * - Debounce support to prevent excessive callback calls
 * - Passive event listener for performance
 * - Automatic cleanup on unmount
 */

import { useRef, useCallback, useEffect } from 'react';

/**
 * Options for useScrollObserver hook
 */
export interface ScrollObserverOptions {
  /** Threshold in pixels from edge to trigger callback (default: 100) */
  threshold?: number;
  /** Callback when scroll position is near the top */
  onNearTop?: () => void;
  /** Callback when scroll position is near the bottom */
  onNearBottom?: () => void;
  /** Debounce time in milliseconds (default: 100) */
  debounceMs?: number;
}

/**
 * Return type for useScrollObserver hook
 */
export interface UseScrollObserverReturn {
  /** Ref to attach to the scroll container */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Manual scroll handler (for testing) */
  handleScroll: () => void;
}

/**
 * Hook for observing scroll position and triggering callbacks at edges
 *
 * @param options - Configuration options
 * @returns Object with containerRef and handleScroll function
 *
 * @example
 * ```tsx
 * function MyComponent() {
 *   const { containerRef } = useScrollObserver({
 *     threshold: 100,
 *     onNearTop: () => loadOlderMessages(),
 *     onNearBottom: () => loadNewerMessages(),
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
export function useScrollObserver(
  options: ScrollObserverOptions
): UseScrollObserverReturn {
  const {
    threshold = 100,
    onNearTop,
    onNearBottom,
    debounceMs = 100,
  } = options;

  // Refs
  const containerRef = useRef<HTMLDivElement>(null);
  const lastCallTimeRef = useRef<number>(0);

  /**
   * Handle scroll event
   * Checks if scroll position is near top or bottom and calls appropriate callbacks
   */
  const handleScroll = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;

    const now = Date.now();
    const timeSinceLastCall = now - lastCallTimeRef.current;

    // Debounce: skip if called too recently
    if (timeSinceLastCall < debounceMs && lastCallTimeRef.current !== 0) {
      return;
    }

    const { scrollTop, scrollHeight, clientHeight } = container;

    // Calculate bottom position
    const bottomPosition = scrollHeight - clientHeight;

    // Check if near top
    if (onNearTop && scrollTop <= threshold) {
      lastCallTimeRef.current = now;
      onNearTop();
    }

    // Check if near bottom
    if (onNearBottom && scrollTop >= bottomPosition - threshold) {
      lastCallTimeRef.current = now;
      onNearBottom();
    }
  }, [threshold, onNearTop, onNearBottom, debounceMs]);

  // Set up scroll event listener
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // Add passive scroll listener for performance
    container.addEventListener('scroll', handleScroll, { passive: true });

    return () => {
      container.removeEventListener('scroll', handleScroll);
    };
  }, [handleScroll]);

  return {
    containerRef,
    handleScroll,
  };
}

export default useScrollObserver;
