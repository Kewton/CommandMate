/**
 * usePromptAnimation Hook
 *
 * Manages animation state for prompt panel fade in/out transitions.
 * Ensures smooth mounting/unmounting with CSS transitions.
 */

'use client';

import { useState, useEffect, useRef, useMemo } from 'react';

/** Default animation duration in milliseconds */
const DEFAULT_ANIMATION_DURATION = 200;

/** CSS class names for animation states */
const ANIMATION_CLASSES = {
  fadeIn: 'animate-fade-in',
  fadeOut: 'animate-fade-out',
  none: '',
} as const;

/**
 * Options for usePromptAnimation hook
 */
export interface UsePromptAnimationOptions {
  /** Whether the component should be visible */
  visible: boolean;
  /** Animation duration in milliseconds */
  duration?: number;
}

/**
 * Return type for usePromptAnimation hook
 */
export interface UsePromptAnimationReturn {
  /** Whether the component should be rendered in the DOM */
  shouldRender: boolean;
  /** CSS class string for animation (fade-in or fade-out) */
  animationClass: string;
  /** Whether animation is currently in progress */
  isAnimating: boolean;
}

/**
 * Animation states for state machine
 */
type AnimationState = 'hidden' | 'fade-in' | 'visible' | 'fade-out';

/**
 * Hook for managing prompt panel animation states
 *
 * Provides fade-in/fade-out animation support with proper cleanup.
 * Component should only be unmounted after fade-out animation completes.
 *
 * @param options - Animation configuration options
 * @returns Animation state and CSS class
 *
 * @example
 * ```tsx
 * const { shouldRender, animationClass, isAnimating } = usePromptAnimation({
 *   visible: promptVisible,
 *   duration: 200,
 * });
 *
 * if (!shouldRender) return null;
 *
 * return (
 *   <div className={`prompt-panel ${animationClass}`}>
 *     ...
 *   </div>
 * );
 * ```
 */
export function usePromptAnimation({
  visible,
  duration = DEFAULT_ANIMATION_DURATION,
}: UsePromptAnimationOptions): UsePromptAnimationReturn {
  const [animationState, setAnimationState] = useState<AnimationState>(
    visible ? 'visible' : 'hidden'
  );
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const prevVisibleRef = useRef(visible);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
      }
    };
  }, []);

  // Handle visibility changes
  useEffect(() => {
    const prevVisible = prevVisibleRef.current;
    prevVisibleRef.current = visible;

    // Clear any pending timeout
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }

    // Helper to schedule animation completion
    const scheduleAnimationEnd = (targetState: AnimationState) => {
      timeoutRef.current = setTimeout(() => {
        setAnimationState(targetState);
        timeoutRef.current = null;
      }, duration);
    };

    if (visible && !prevVisible) {
      // Showing: start fade-in animation
      setAnimationState('fade-in');
      scheduleAnimationEnd('visible');
    } else if (!visible && prevVisible) {
      // Hiding: start fade-out animation
      setAnimationState('fade-out');
      scheduleAnimationEnd('hidden');
    } else if (visible) {
      // Handle interruption during fade-out
      setAnimationState((current) => {
        if (current === 'fade-out') {
          scheduleAnimationEnd('visible');
          return 'fade-in';
        }
        return current;
      });
    } else {
      // Handle interruption during fade-in
      setAnimationState((current) => {
        if (current === 'fade-in') {
          scheduleAnimationEnd('hidden');
          return 'fade-out';
        }
        return current;
      });
    }
  }, [visible, duration]);

  // Compute derived values with memoization
  const shouldRender = animationState !== 'hidden';
  const isAnimating = animationState === 'fade-in' || animationState === 'fade-out';

  const animationClass = useMemo(() => {
    switch (animationState) {
      case 'fade-in':
        return ANIMATION_CLASSES.fadeIn;
      case 'fade-out':
        return ANIMATION_CLASSES.fadeOut;
      default:
        return ANIMATION_CLASSES.none;
    }
  }, [animationState]);

  return {
    shouldRender,
    animationClass,
    isAnimating,
  };
}

export default usePromptAnimation;
