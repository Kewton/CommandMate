/**
 * Tests for useLongPress hook
 *
 * Tests long press detection for touch devices (iPad/iPhone).
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useLongPress, LONG_PRESS_DELAY, MOVE_THRESHOLD } from '@/hooks/useLongPress';

describe('useLongPress', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /**
   * Helper to create a mock TouchEvent
   */
  const createTouchEvent = (
    touches: Array<{ clientX: number; clientY: number }>
  ): React.TouchEvent => {
    const mockEvent = {
      preventDefault: vi.fn(),
      touches: touches.map((t, i) => ({
        identifier: i,
        target: document.createElement('div'),
        clientX: t.clientX,
        clientY: t.clientY,
        screenX: t.clientX,
        screenY: t.clientY,
        pageX: t.clientX,
        pageY: t.clientY,
        radiusX: 0,
        radiusY: 0,
        rotationAngle: 0,
        force: 1,
      })) as unknown as React.TouchList,
      targetTouches: [] as unknown as React.TouchList,
      changedTouches: [] as unknown as React.TouchList,
      altKey: false,
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
      type: 'touchstart',
      nativeEvent: {} as TouchEvent,
      currentTarget: document.createElement('div') as EventTarget & Element,
      target: document.createElement('div') as EventTarget & Element,
      bubbles: true,
      cancelable: true,
      defaultPrevented: false,
      eventPhase: 0,
      isTrusted: true,
      timeStamp: Date.now(),
      isDefaultPrevented: () => false,
      isPropagationStopped: () => false,
      persist: () => {},
      stopPropagation: () => {},
      // Additional required properties for React.TouchEvent
      getModifierState: () => false,
      detail: 0,
      view: null as unknown as Window,
    };
    return mockEvent as unknown as React.TouchEvent;
  };

  describe('constants', () => {
    it('should export LONG_PRESS_DELAY as 500ms', () => {
      expect(LONG_PRESS_DELAY).toBe(500);
    });

    it('should export MOVE_THRESHOLD as 10px', () => {
      expect(MOVE_THRESHOLD).toBe(10);
    });
  });

  describe('long press detection', () => {
    it('should call onLongPress after 500ms', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const touchEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(touchEvent);
      });

      expect(onLongPress).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).toHaveBeenCalledTimes(1);
      expect(onLongPress).toHaveBeenCalledWith(touchEvent);
    });

    it('should use custom delay when provided', () => {
      const onLongPress = vi.fn();
      const customDelay = 300;
      const { result } = renderHook(() =>
        useLongPress({ onLongPress, delay: customDelay })
      );

      const touchEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(touchEvent);
      });

      act(() => {
        vi.advanceTimersByTime(customDelay - 1);
      });

      expect(onLongPress).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(onLongPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('move threshold cancellation', () => {
    it('should clear timer when touch moves more than 10px', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const startEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(startEvent);
      });

      // Move beyond threshold (11px horizontal)
      const moveEvent = createTouchEvent([{ clientX: 111, clientY: 100 }]);

      act(() => {
        result.current.onTouchMove(moveEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });

    it('should clear timer when touch moves 10px diagonally', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const startEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(startEvent);
      });

      // Move diagonal distance > 10px (sqrt(8*8 + 8*8) = ~11.3px)
      const moveEvent = createTouchEvent([{ clientX: 108, clientY: 108 }]);

      act(() => {
        result.current.onTouchMove(moveEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });

    it('should NOT clear timer when touch moves less than 10px', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const startEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(startEvent);
      });

      // Move less than threshold (5px)
      const moveEvent = createTouchEvent([{ clientX: 105, clientY: 100 }]);

      act(() => {
        result.current.onTouchMove(moveEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).toHaveBeenCalledTimes(1);
    });

    it('should use custom moveThreshold when provided', () => {
      const onLongPress = vi.fn();
      const customThreshold = 20;
      const { result } = renderHook(() =>
        useLongPress({ onLongPress, moveThreshold: customThreshold })
      );

      const startEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(startEvent);
      });

      // Move 15px (beyond default but within custom threshold)
      const moveEvent = createTouchEvent([{ clientX: 115, clientY: 100 }]);

      act(() => {
        result.current.onTouchMove(moveEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('touchend cancellation', () => {
    it('should clear timer on touchend', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const touchEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(touchEvent);
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      act(() => {
        result.current.onTouchEnd();
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });
  });

  describe('touchcancel cancellation', () => {
    it('should clear timer on touchcancel', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      const touchEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(touchEvent);
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      act(() => {
        result.current.onTouchCancel();
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });
  });

  describe('unmount cleanup', () => {
    it('should clear timer on unmount', () => {
      const onLongPress = vi.fn();
      const { result, unmount } = renderHook(() => useLongPress({ onLongPress }));

      const touchEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(touchEvent);
      });

      act(() => {
        vi.advanceTimersByTime(300);
      });

      unmount();

      act(() => {
        vi.advanceTimersByTime(300);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });
  });

  describe('multi-touch handling', () => {
    it('should not fire on multi-touch (2+ fingers)', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      // Start with 2 fingers
      const multiTouchEvent = createTouchEvent([
        { clientX: 100, clientY: 100 },
        { clientX: 200, clientY: 200 },
      ]);

      act(() => {
        result.current.onTouchStart(multiTouchEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      expect(onLongPress).not.toHaveBeenCalled();
    });

    it('should ignore touchmove with multiple touches', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      // Start with single touch
      const startEvent = createTouchEvent([{ clientX: 100, clientY: 100 }]);

      act(() => {
        result.current.onTouchStart(startEvent);
      });

      // Move with 2 fingers (should be ignored, timer continues)
      const multiMoveEvent = createTouchEvent([
        { clientX: 150, clientY: 150 },
        { clientX: 200, clientY: 200 },
      ]);

      act(() => {
        result.current.onTouchMove(multiMoveEvent);
      });

      act(() => {
        vi.advanceTimersByTime(LONG_PRESS_DELAY);
      });

      // Should still fire because multi-touch move is ignored
      expect(onLongPress).toHaveBeenCalledTimes(1);
    });
  });

  describe('callback stability', () => {
    it('should have stable onTouchStart callback reference', () => {
      const onLongPress = vi.fn();
      const { result, rerender } = renderHook(() => useLongPress({ onLongPress }));

      const handler1 = result.current.onTouchStart;
      rerender();
      const handler2 = result.current.onTouchStart;

      expect(handler1).toBe(handler2);
    });

    it('should have stable onTouchMove callback reference', () => {
      const onLongPress = vi.fn();
      const { result, rerender } = renderHook(() => useLongPress({ onLongPress }));

      const handler1 = result.current.onTouchMove;
      rerender();
      const handler2 = result.current.onTouchMove;

      expect(handler1).toBe(handler2);
    });

    it('should have stable onTouchEnd callback reference', () => {
      const onLongPress = vi.fn();
      const { result, rerender } = renderHook(() => useLongPress({ onLongPress }));

      const handler1 = result.current.onTouchEnd;
      rerender();
      const handler2 = result.current.onTouchEnd;

      expect(handler1).toBe(handler2);
    });

    it('should have stable onTouchCancel callback reference', () => {
      const onLongPress = vi.fn();
      const { result, rerender } = renderHook(() => useLongPress({ onLongPress }));

      const handler1 = result.current.onTouchCancel;
      rerender();
      const handler2 = result.current.onTouchCancel;

      expect(handler1).toBe(handler2);
    });
  });

  describe('return value structure', () => {
    it('should return all required touch handlers', () => {
      const onLongPress = vi.fn();
      const { result } = renderHook(() => useLongPress({ onLongPress }));

      expect(typeof result.current.onTouchStart).toBe('function');
      expect(typeof result.current.onTouchMove).toBe('function');
      expect(typeof result.current.onTouchEnd).toBe('function');
      expect(typeof result.current.onTouchCancel).toBe('function');
    });
  });
});
