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
import {
  isFullscreenSupportedCompat,
  getFullscreenElementCompat,
  requestFullscreenCompat,
  exitFullscreenCompat,
  addFullscreenChangeListenerCompat,
} from '@/lib/browser-compat/fullscreen-api';

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
  elementRef?: RefObject<HTMLElement | null>;
  /** Callback when entering fullscreen */
  onEnter?: () => void;
  /** Callback when exiting fullscreen */
  onExit?: () => void;
  /** Callback when error occurs */
  onError?: (error: Error) => void;
}

/**
 * Check if device is iOS/iPadOS
 * Issue #104: iOS/iPadOS automatically exits fullscreen when virtual keyboard appears,
 * so we force CSS fallback mode on these devices to maintain fullscreen during editing.
 *
 * Detection covers:
 * - iPad/iPhone/iPod via userAgent
 * - iPad Pro (reports as MacIntel but has touch support)
 */
function isIOSDevice(): boolean {
  if (typeof navigator === 'undefined') return false;

  // Check for iPad, iPhone, iPod in userAgent
  if (/iPad|iPhone|iPod/.test(navigator.userAgent)) {
    return true;
  }

  // iPad Pro running iPadOS 13+ reports as MacIntel
  // Detect by checking for touch support on Mac platform
  if (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) {
    return true;
  }

  return false;
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
    const element = getFullscreenElementCompat();
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
   *
   * Issue #104: On iOS/iPadOS, the Fullscreen API automatically exits when the
   * virtual keyboard appears. To maintain fullscreen during text editing,
   * we force CSS fallback mode on these devices.
   */
  const enterFullscreen = useCallback(async () => {
    setError(null);

    // Issue #104: Force CSS fallback on iOS/iPadOS to prevent
    // automatic fullscreen exit when virtual keyboard appears
    if (isIOSDevice()) {
      setIsFullscreen(true);
      setIsFallbackMode(true);
      onEnter?.();
      return;
    }

    // If API is supported, use it
    if (isFullscreenSupportedCompat() && elementRef?.current) {
      try {
        await requestFullscreenCompat(elementRef.current);
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
    if (getFullscreenElementCompat()) {
      try {
        await exitFullscreenCompat();
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
    return addFullscreenChangeListenerCompat(updateFullscreenState);
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
