/**
 * Tests for useVirtualKeyboard hook
 *
 * Tests virtual keyboard detection using visualViewport API
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';

import { useVirtualKeyboard } from '@/hooks/useVirtualKeyboard';

describe('useVirtualKeyboard', () => {
  // Store original visualViewport
  let originalVisualViewport: VisualViewport | null;

  beforeEach(() => {
    originalVisualViewport = window.visualViewport;
    vi.clearAllMocks();
  });

  afterEach(() => {
    // Restore original visualViewport
    Object.defineProperty(window, 'visualViewport', {
      value: originalVisualViewport,
      writable: true,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  /**
   * Helper to mock visualViewport
   */
  function mockVisualViewport(options: { height: number; offsetTop?: number }) {
    const listeners: Map<string, EventListener[]> = new Map();

    const viewport = {
      height: options.height,
      offsetTop: options.offsetTop ?? 0,
      width: 375,
      offsetLeft: 0,
      pageTop: 0,
      pageLeft: 0,
      scale: 1,
      addEventListener: vi.fn((event: string, listener: EventListener) => {
        if (!listeners.has(event)) {
          listeners.set(event, []);
        }
        listeners.get(event)!.push(listener);
      }),
      removeEventListener: vi.fn((event: string, listener: EventListener) => {
        const eventListeners = listeners.get(event);
        if (eventListeners) {
          const index = eventListeners.indexOf(listener);
          if (index > -1) {
            eventListeners.splice(index, 1);
          }
        }
      }),
      dispatchEvent: vi.fn(),
      // Helper to trigger resize
      _triggerResize: () => {
        const resizeListeners = listeners.get('resize') || [];
        resizeListeners.forEach(listener => listener(new Event('resize')));
      },
    } as unknown as VisualViewport & { _triggerResize: () => void };

    Object.defineProperty(window, 'visualViewport', {
      value: viewport,
      writable: true,
      configurable: true,
    });

    return viewport;
  }

  describe('Initial State', () => {
    it('should return isKeyboardVisible as false initially', () => {
      mockVisualViewport({ height: 800 });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current.isKeyboardVisible).toBe(false);
    });

    it('should return keyboardHeight as 0 initially', () => {
      mockVisualViewport({ height: 800 });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current.keyboardHeight).toBe(0);
    });
  });

  describe('Return Value Types', () => {
    it('should return isKeyboardVisible as boolean', () => {
      mockVisualViewport({ height: 800 });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(typeof result.current.isKeyboardVisible).toBe('boolean');
    });

    it('should return keyboardHeight as number', () => {
      mockVisualViewport({ height: 800 });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(typeof result.current.keyboardHeight).toBe('number');
    });
  });

  describe('Fallback for Unsupported Browsers', () => {
    it('should return default values when visualViewport is not supported', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: null,
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current.isKeyboardVisible).toBe(false);
      expect(result.current.keyboardHeight).toBe(0);
    });

    it('should not throw error when visualViewport is undefined', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: undefined,
        writable: true,
        configurable: true,
      });

      expect(() => {
        renderHook(() => useVirtualKeyboard());
      }).not.toThrow();
    });

    it('should return safe default values when visualViewport is null', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: null,
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current).toEqual({
        isKeyboardVisible: false,
        keyboardHeight: 0,
      });
    });
  });

  describe('Event Listener Management', () => {
    it('should add resize event listener on mount when visualViewport exists', () => {
      const viewportMock = mockVisualViewport({ height: 800 });

      renderHook(() => useVirtualKeyboard());

      expect(viewportMock.addEventListener).toHaveBeenCalledWith(
        'resize',
        expect.any(Function)
      );
    });

    it('should remove event listener on unmount', () => {
      const viewportMock = mockVisualViewport({ height: 800 });

      const { unmount } = renderHook(() => useVirtualKeyboard());

      unmount();

      expect(viewportMock.removeEventListener).toHaveBeenCalledWith(
        'resize',
        expect.any(Function)
      );
    });

    it('should not add listener when visualViewport is null', () => {
      Object.defineProperty(window, 'visualViewport', {
        value: null,
        writable: true,
        configurable: true,
      });

      // Should not throw
      const { unmount } = renderHook(() => useVirtualKeyboard());
      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Hook Stability', () => {
    it('should maintain stable return values across re-renders when no change', () => {
      mockVisualViewport({ height: 800 });

      const { result, rerender } = renderHook(() => useVirtualKeyboard());

      const initialValues = { ...result.current };

      rerender();

      expect(result.current.isKeyboardVisible).toBe(initialValues.isKeyboardVisible);
      expect(result.current.keyboardHeight).toBe(initialValues.keyboardHeight);
    });
  });

  describe('Cleanup', () => {
    it('should not throw on unmount', () => {
      mockVisualViewport({ height: 800 });

      const { unmount } = renderHook(() => useVirtualKeyboard());

      expect(() => unmount()).not.toThrow();
    });

    it('should cleanup gracefully when visualViewport becomes null', () => {
      mockVisualViewport({ height: 800 });

      const { unmount } = renderHook(() => useVirtualKeyboard());

      // Simulate visualViewport becoming null
      Object.defineProperty(window, 'visualViewport', {
        value: null,
        writable: true,
        configurable: true,
      });

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('SSR Support', () => {
    it('should handle SSR environment gracefully', () => {
      // In jsdom, window always exists, but visualViewport may not
      Object.defineProperty(window, 'visualViewport', {
        value: null,
        writable: true,
        configurable: true,
      });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current.isKeyboardVisible).toBe(false);
      expect(result.current.keyboardHeight).toBe(0);
    });
  });

  describe('Default Behavior', () => {
    it('should report keyboard not visible when viewport matches window height', () => {
      // Match viewport height to window inner height
      const windowHeight = window.innerHeight;
      mockVisualViewport({ height: windowHeight });

      const { result } = renderHook(() => useVirtualKeyboard());

      expect(result.current.isKeyboardVisible).toBe(false);
      expect(result.current.keyboardHeight).toBe(0);
    });
  });
});
