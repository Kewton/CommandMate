/**
 * useFullscreen Hook
 *
 * Provides fullscreen functionality with Fullscreen API support
 * and CSS fallback for browsers without API support (e.g., iOS Safari).
 *
 * Security: Fullscreen API requires user gesture (click, keydown, etc.)
 *
 * @module hooks/useFullscreen
 */

'use client';

import { useState, useCallback, useEffect, RefObject } from 'react';

/**
 * Return type for useFullscreen hook
 */
export interface UseFullscreenReturn {
  /** Whether the element is currently in fullscreen mode */
  isFullscreen: boolean;
  /** Whether CSS fallback mode is active (API not available) */
  isFallbackMode: boolean;
  /** Enter fullscreen mode */
  enterFullscreen: () => Promise<void>;
  /** Exit fullscreen mode */
  exitFullscreen: () => Promise<void>;
  /** Toggle fullscreen mode */
  toggleFullscreen: () => Promise<void>;
  /** Error message if last operation failed */
  error: string | null;
}

/**
 * Options for useFullscreen hook
 */
export interface UseFullscreenOptions {
  /** Reference to the element to make fullscreen */
  elementRef?: RefObject<HTMLElement>;
  /** Callback when entering fullscreen */
  onEnter?: () => void;
  /** Callback when exiting fullscreen */
  onExit?: () => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
}

/**
 * Check if Fullscreen API is available
 */
function isFullscreenSupported(): boolean {
  return (
    typeof document !== 'undefined' &&
    (document.fullscreenEnabled ||
      // @ts-expect-error - webkit prefix
      document.webkitFullscreenEnabled ||
      // @ts-expect-error - moz prefix
      document.mozFullScreenEnabled ||
      // @ts-expect-error - ms prefix
      document.msFullscreenEnabled)
  );
}

/**
 * Get the current fullscreen element
 */
function getFullscreenElement(): Element | null {
  if (typeof document === 'undefined') return null;

  return (
    document.fullscreenElement ||
    // @ts-expect-error - webkit prefix
    document.webkitFullscreenElement ||
    // @ts-expect-error - moz prefix
    document.mozFullScreenElement ||
    // @ts-expect-error - ms prefix
    document.msFullscreenElement ||
    null
  );
}

/**
 * Request fullscreen on an element
 */
async function requestFullscreen(element: Element): Promise<void> {
  if (element.requestFullscreen) {
    return element.requestFullscreen();
  }
  // @ts-expect-error - webkit prefix
  if (element.webkitRequestFullscreen) {
    // @ts-expect-error - webkit prefix
    return element.webkitRequestFullscreen();
  }
  // @ts-expect-error - moz prefix
  if (element.mozRequestFullScreen) {
    // @ts-expect-error - moz prefix
    return element.mozRequestFullScreen();
  }
  // @ts-expect-error - ms prefix
  if (element.msRequestFullscreen) {
    // @ts-expect-error - ms prefix
    return element.msRequestFullscreen();
  }
  throw new Error('Fullscreen API not supported');
}

/**
 * Exit fullscreen mode
 */
async function exitFullscreenApi(): Promise<void> {
  if (typeof document === 'undefined') return;

  if (document.exitFullscreen) {
    return document.exitFullscreen();
  }
  // @ts-expect-error - webkit prefix
  if (document.webkitExitFullscreen) {
    // @ts-expect-error - webkit prefix
    return document.webkitExitFullscreen();
  }
  // @ts-expect-error - moz prefix
  if (document.mozCancelFullScreen) {
    // @ts-expect-error - moz prefix
    return document.mozCancelFullScreen();
  }
  // @ts-expect-error - ms prefix
  if (document.msExitFullscreen) {
    // @ts-expect-error - ms prefix
    return document.msExitFullscreen();
  }
}

/**
 * Hook for managing fullscreen state with API support and CSS fallback
 *
 * @param options - Configuration options
 * @returns Fullscreen state and control functions
 *
 * @example
 * ```tsx
 * function MaximizableEditor() {
 *   const containerRef = useRef<HTMLDivElement>(null);
 *   const { isFullscreen, toggleFullscreen, isFallbackMode } = useFullscreen({
 *     elementRef: containerRef,
 *     onEnter: () => console.log('Entered fullscreen'),
 *     onExit: () => console.log('Exited fullscreen'),
 *   });
 *
 *   return (
 *     <div ref={containerRef} className={isFallbackMode && isFullscreen ? 'fixed inset-0' : ''}>
 *       <button onClick={toggleFullscreen}>
 *         {isFullscreen ? 'Exit' : 'Enter'} Fullscreen
 *       </button>
 *     </div>
 *   );
 * }
 * ```
 */
export function useFullscreen(options: UseFullscreenOptions = {}): UseFullscreenReturn {
  const { elementRef, onEnter, onExit, onError } = options;

  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isFallbackMode, setIsFallbackMode] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Update fullscreen state from API
   */
  const updateFullscreenState = useCallback(() => {
    const element = getFullscreenElement();
    const isActive = element != null;
    setIsFullscreen(isActive);

    // If we exited fullscreen via API, ensure fallback mode is off
    if (!isActive && isFallbackMode) {
      setIsFallbackMode(false);
    }
  }, [isFallbackMode]);

  /**
   * Enter fullscreen mode
   * IMPORTANT: Must be called from user gesture (click, keydown, etc.)
   */
  const enterFullscreen = useCallback(async () => {
    setError(null);

    // If API is supported, use it
    if (isFullscreenSupported() && elementRef?.current) {
      try {
        await requestFullscreen(elementRef.current);
        setIsFullscreen(true);
        setIsFallbackMode(false);
        onEnter?.();
      } catch (err) {
        // Fullscreen may fail due to permissions or not being called from user gesture
        const message = err instanceof Error ? err.message : 'Failed to enter fullscreen';
        setError(message);
        onError?.(err instanceof Error ? err : new Error(message));

        // Fall back to CSS-based fullscreen
        setIsFullscreen(true);
        setIsFallbackMode(true);
        onEnter?.();
      }
    } else {
      // No API support or no element ref - use CSS fallback
      setIsFullscreen(true);
      setIsFallbackMode(true);
      onEnter?.();
    }
  }, [elementRef, onEnter, onError]);

  /**
   * Exit fullscreen mode
   */
  const exitFullscreen = useCallback(async () => {
    setError(null);

    // If in fallback mode, just update state
    if (isFallbackMode) {
      setIsFullscreen(false);
      setIsFallbackMode(false);
      onExit?.();
      return;
    }

    // If using API, exit via API
    if (getFullscreenElement()) {
      try {
        await exitFullscreenApi();
        setIsFullscreen(false);
        onExit?.();
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to exit fullscreen';
        setError(message);
        onError?.(err instanceof Error ? err : new Error(message));

        // Force exit state anyway
        setIsFullscreen(false);
        setIsFallbackMode(false);
        onExit?.();
      }
    } else {
      // Not in API fullscreen, just update state
      setIsFullscreen(false);
      setIsFallbackMode(false);
      onExit?.();
    }
  }, [isFallbackMode, onExit, onError]);

  /**
   * Toggle fullscreen mode
   */
  const toggleFullscreen = useCallback(async () => {
    if (isFullscreen) {
      await exitFullscreen();
    } else {
      await enterFullscreen();
    }
  }, [isFullscreen, enterFullscreen, exitFullscreen]);

  /**
   * Listen for fullscreen change events from API
   */
  useEffect(() => {
    if (typeof document === 'undefined') return;

    document.addEventListener('fullscreenchange', updateFullscreenState);
    document.addEventListener('webkitfullscreenchange', updateFullscreenState);
    document.addEventListener('mozfullscreenchange', updateFullscreenState);
    document.addEventListener('MSFullscreenChange', updateFullscreenState);

    return () => {
      document.removeEventListener('fullscreenchange', updateFullscreenState);
      document.removeEventListener('webkitfullscreenchange', updateFullscreenState);
      document.removeEventListener('mozfullscreenchange', updateFullscreenState);
      document.removeEventListener('MSFullscreenChange', updateFullscreenState);
    };
  }, [updateFullscreenState]);

  return {
    isFullscreen,
    isFallbackMode,
    enterFullscreen,
    exitFullscreen,
    toggleFullscreen,
    error,
  };
}

export default useFullscreen;
