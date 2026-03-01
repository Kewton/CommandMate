/**
 * useTerminalScroll Hook
 *
 * Manages auto-scroll behavior for terminal display
 * - Auto-scrolls to bottom when new content arrives
 * - Pauses auto-scroll when user scrolls up
 * - Resumes auto-scroll when user clicks "scroll to bottom"
 */

'use client';

import { useRef, useState, useCallback } from 'react';

/**
 * Threshold in pixels for detecting if user is "at the bottom"
 * This provides tolerance for small variations
 */
const BOTTOM_THRESHOLD = 50;

/**
 * Options for useTerminalScroll hook
 */
export interface UseTerminalScrollOptions {
  /** Initial auto-scroll state (default: true) */
  initialAutoScroll?: boolean;
  /** Callback when auto-scroll state changes */
  onAutoScrollChange?: (enabled: boolean) => void;
}

/**
 * Return type for useTerminalScroll hook
 */
export interface UseTerminalScrollReturn {
  /** Ref to attach to the scrollable container */
  scrollRef: React.RefObject<HTMLDivElement>;
  /** Whether auto-scroll is currently enabled */
  autoScroll: boolean;
  /** Manually set auto-scroll state */
  setAutoScroll: (enabled: boolean) => void;
  /** Scroll to the bottom of the container */
  scrollToBottom: () => void;
  /** Scroll to the top of the container */
  scrollToTop: () => void;
  /** Handle scroll events (call this from onScroll) */
  handleScroll: () => void;
}

/**
 * Custom hook for managing terminal scroll behavior
 *
 * @param options - Configuration options
 * @returns Object containing scroll controls and state
 *
 * @example
 * ```tsx
 * function TerminalDisplay({ output }) {
 *   const { scrollRef, autoScroll, scrollToBottom, handleScroll } = useTerminalScroll();
 *
 *   return (
 *     <div>
 *       <div ref={scrollRef} onScroll={handleScroll}>
 *         {output}
 *       </div>
 *       {!autoScroll && (
 *         <button onClick={scrollToBottom}>Scroll to bottom</button>
 *       )}
 *     </div>
 *   );
 * }
 * ```
 */
export function useTerminalScroll(
  options: UseTerminalScrollOptions = {}
): UseTerminalScrollReturn {
  const { initialAutoScroll = true, onAutoScrollChange } = options;

  const scrollRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScrollState] = useState(initialAutoScroll);

  /**
   * Set auto-scroll state with callback notification
   */
  const setAutoScroll = useCallback(
    (enabled: boolean) => {
      setAutoScrollState(enabled);
      onAutoScrollChange?.(enabled);
    },
    [onAutoScrollChange]
  );

  /**
   * Check if the container is scrolled to the bottom (within threshold)
   */
  const isAtBottom = useCallback((): boolean => {
    const element = scrollRef.current;
    if (!element) return true;

    const { scrollTop, scrollHeight, clientHeight } = element;
    const distanceFromBottom = scrollHeight - clientHeight - scrollTop;

    return distanceFromBottom <= BOTTOM_THRESHOLD;
  }, []);

  /**
   * Handle scroll events from the container
   * Disables auto-scroll when user scrolls away from bottom
   */
  const handleScroll = useCallback(() => {
    const atBottom = isAtBottom();

    if (atBottom && !autoScroll) {
      // User scrolled back to bottom, re-enable auto-scroll
      setAutoScroll(true);
    } else if (!atBottom && autoScroll) {
      // User scrolled up, disable auto-scroll
      setAutoScroll(false);
    }
  }, [autoScroll, isAtBottom, setAutoScroll]);

  /**
   * Programmatically scroll to the bottom of the container
   * Also re-enables auto-scroll
   */
  const scrollToBottom = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    element.scrollTo({
      top: element.scrollHeight,
      behavior: 'smooth',
    });

    // Re-enable auto-scroll when user explicitly scrolls to bottom
    if (!autoScroll) {
      setAutoScroll(true);
    }
  }, [autoScroll, setAutoScroll]);

  /**
   * Programmatically scroll to the top of the container
   * Disables auto-scroll so the view stays at the top
   */
  const scrollToTop = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    element.scrollTo({
      top: 0,
      behavior: 'smooth',
    });

    if (autoScroll) {
      setAutoScroll(false);
    }
  }, [autoScroll, setAutoScroll]);

  return {
    scrollRef,
    autoScroll,
    setAutoScroll,
    scrollToBottom,
    scrollToTop,
    handleScroll,
  };
}
