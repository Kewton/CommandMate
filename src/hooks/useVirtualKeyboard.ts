/**
 * useVirtualKeyboard Hook
 *
 * Detects virtual keyboard visibility using visualViewport API
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

/**
 * Return type for useVirtualKeyboard hook
 */
export interface UseVirtualKeyboardReturn {
  /** Whether the virtual keyboard is visible */
  isKeyboardVisible: boolean;
  /** Height of the virtual keyboard in pixels */
  keyboardHeight: number;
}

/**
 * Minimum height difference to consider keyboard visible.
 * Small changes might be due to browser chrome or orientation changes.
 */
const KEYBOARD_THRESHOLD = 100;

/**
 * Check if visualViewport API is available
 */
const isVisualViewportSupported = (): boolean =>
  typeof window !== 'undefined' && window.visualViewport != null;

/**
 * Hook for detecting virtual keyboard visibility
 *
 * Uses the visualViewport API to detect when the virtual keyboard
 * appears or disappears on mobile devices.
 *
 * @returns Object containing isKeyboardVisible and keyboardHeight
 *
 * @example
 * ```tsx
 * function InputWithKeyboardAwareness() {
 *   const { isKeyboardVisible, keyboardHeight } = useVirtualKeyboard();
 *
 *   return (
 *     <div style={{ paddingBottom: isKeyboardVisible ? keyboardHeight : 0 }}>
 *       <input type="text" />
 *     </div>
 *   );
 * }
 * ```
 */
export function useVirtualKeyboard(): UseVirtualKeyboardReturn {
  const [isKeyboardVisible, setIsKeyboardVisible] = useState(false);
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  /**
   * Calculate keyboard height and visibility
   */
  const updateKeyboardState = useCallback(() => {
    if (!isVisualViewportSupported()) {
      return;
    }

    const viewport = window.visualViewport!;
    const windowHeight = window.innerHeight;
    const viewportHeight = viewport.height;
    const heightDiff = windowHeight - viewportHeight;

    // Only consider keyboard visible if the difference exceeds threshold
    const isVisible = heightDiff > KEYBOARD_THRESHOLD;
    setIsKeyboardVisible(isVisible);
    setKeyboardHeight(isVisible ? heightDiff : 0);
  }, []);

  /**
   * Attach event listeners to visualViewport
   */
  useEffect(() => {
    if (!isVisualViewportSupported()) {
      return;
    }

    const viewport = window.visualViewport!;

    // Initial calculation
    updateKeyboardState();

    // Add resize listener
    viewport.addEventListener('resize', updateKeyboardState);

    return () => {
      viewport.removeEventListener('resize', updateKeyboardState);
    };
  }, [updateKeyboardState]);

  return {
    isKeyboardVisible,
    keyboardHeight,
  };
}

export default useVirtualKeyboard;
