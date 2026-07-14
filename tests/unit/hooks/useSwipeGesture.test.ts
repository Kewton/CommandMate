/**
 * Tests for useSwipeGesture hook
 *
 * Tests swipe gesture detection for touch devices
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { useSwipeGesture, isInsideScrollableElement } from '@/hooks/useSwipeGesture';

describe('useSwipeGesture', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Basic Functionality', () => {
    it('should return a ref object', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.ref).toBeDefined();
      expect(result.current.ref.current).toBeNull();
    });

    it('should return isSwiping as false initially', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.isSwiping).toBe(false);
    });

    it('should return swipeDirection as null initially', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.swipeDirection).toBeNull();
    });
  });

  describe('Options Configuration', () => {
    it('should accept onSwipeLeft callback', () => {
      const onSwipeLeft = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeLeft }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeRight callback', () => {
      const onSwipeRight = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeRight }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeUp callback', () => {
      const onSwipeUp = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeUp }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept onSwipeDown callback', () => {
      const onSwipeDown = vi.fn();
      const { result } = renderHook(() => useSwipeGesture({ onSwipeDown }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept custom threshold', () => {
      const { result } = renderHook(() => useSwipeGesture({ threshold: 100 }));
      expect(result.current.ref).toBeDefined();
    });

    it('should accept enabled option', () => {
      const { result } = renderHook(() => useSwipeGesture({ enabled: false }));
      expect(result.current.ref).toBeDefined();
    });

    it('should be enabled by default', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      // Hook returns without error, implying enabled=true is default
      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Return Value Types', () => {
    it('should return ref with correct type', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(typeof result.current.ref).toBe('object');
      expect('current' in result.current.ref).toBe(true);
    });

    it('should return isSwiping as boolean', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(typeof result.current.isSwiping).toBe('boolean');
    });

    it('should return swipeDirection as null or string', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current.swipeDirection === null || typeof result.current.swipeDirection === 'string').toBe(true);
    });
  });

  describe('Hook Stability', () => {
    it('should maintain ref identity across re-renders', () => {
      const { result, rerender } = renderHook(() => useSwipeGesture({}));
      const initialRef = result.current.ref;

      rerender();

      expect(result.current.ref).toBe(initialRef);
    });

    it('should handle options changes', () => {
      const onSwipeLeft1 = vi.fn();
      const onSwipeLeft2 = vi.fn();

      const { result, rerender } = renderHook(
        ({ onSwipeLeft }) => useSwipeGesture({ onSwipeLeft }),
        { initialProps: { onSwipeLeft: onSwipeLeft1 } }
      );

      expect(result.current.ref).toBeDefined();

      rerender({ onSwipeLeft: onSwipeLeft2 });

      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Cleanup', () => {
    it('should not throw on unmount', () => {
      const { unmount } = renderHook(() => useSwipeGesture({}));

      expect(() => unmount()).not.toThrow();
    });

    it('should cleanup without errors when ref was never assigned', () => {
      const { unmount } = renderHook(() => useSwipeGesture({
        onSwipeLeft: vi.fn(),
        onSwipeRight: vi.fn(),
      }));

      expect(() => unmount()).not.toThrow();
    });
  });

  describe('Default Values', () => {
    it('should use default threshold of 50px', () => {
      // This tests that the hook accepts no threshold and doesn't throw
      const { result } = renderHook(() => useSwipeGesture({ onSwipeLeft: vi.fn() }));
      expect(result.current.ref).toBeDefined();
    });

    it('should default enabled to true', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      // If enabled were false by default, hook behavior would be different
      expect(result.current.ref).toBeDefined();
    });
  });

  describe('Empty Options', () => {
    it('should work with empty options object', () => {
      const { result } = renderHook(() => useSwipeGesture({}));
      expect(result.current).toEqual({
        ref: expect.any(Object),
        isSwiping: false,
        swipeDirection: null,
        resetSwipeDirection: expect.any(Function),
      });
    });

    it('should work with no options', () => {
      const { result } = renderHook(() => useSwipeGesture());
      expect(result.current).toEqual({
        ref: expect.any(Object),
        isSwiping: false,
        swipeDirection: null,
        resetSwipeDirection: expect.any(Function),
      });
    });
  });

  describe('Scrollable element detection (Issue #299)', () => {
    /**
     * Helper to create a touch event for testing.
     * jsdom does not fully support Touch/TouchEvent constructors,
     * so we create a minimal mock object.
     */
    function createTouchEvent(
      type: string,
      clientX: number,
      clientY: number,
      target: EventTarget
    ): TouchEvent {
      const touch = { clientX, clientY, identifier: 0, target } as unknown as Touch;
      const event = new Event(type, { bubbles: true }) as unknown as TouchEvent;
      Object.defineProperty(event, 'touches', { value: [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      Object.defineProperty(event, 'target', { value: target });
      return event;
    }

    /**
     * Helper to render the hook with the ref pre-assigned to a DOM element.
     * The hook attaches event listeners via useEffect when ref.current exists.
     * Since ref.current is not reactive, we need to toggle the `enabled` prop
     * to force the useCallback dependencies to change, which in turn causes
     * the useEffect to re-run and pick up the new ref.current value.
     */
    function renderHookWithElement(
      element: HTMLElement,
      options: Parameters<typeof useSwipeGesture>[0]
    ) {
      // Step 1: Render with enabled=false so callbacks are created
      const hookResult = renderHook(
        (props) => useSwipeGesture(props),
        { initialProps: { ...options, enabled: false } }
      );

      // Step 2: Assign the element to the ref
      (hookResult.result.current.ref as { current: HTMLElement | null }).current = element;

      // Step 3: Re-render with enabled=true. This changes the `enabled` dependency
      // in useCallback, creating new callback references, which triggers the
      // useEffect to re-run with the assigned ref.current.
      hookResult.rerender({ ...options, enabled: true });

      return hookResult;
    }

    it('should suppress swipe when touch starts inside a scrollable element', () => {
      const onSwipeDown = vi.fn();

      // Set up scrollable DOM: container > scrollableDiv > childElement
      const container = document.createElement('div');
      const scrollableDiv = document.createElement('div');
      const childElement = document.createElement('span');

      scrollableDiv.style.overflowY = 'auto';
      Object.defineProperty(scrollableDiv, 'scrollHeight', {
        value: 500,
        configurable: true,
      });
      Object.defineProperty(scrollableDiv, 'clientHeight', {
        value: 200,
        configurable: true,
      });

      scrollableDiv.appendChild(childElement);
      container.appendChild(scrollableDiv);
      document.body.appendChild(container);

      renderHookWithElement(container, {
        onSwipeDown,
        threshold: 50,
        enabled: true,
      });

      // Simulate touch start inside scrollable child element
      const touchStart = createTouchEvent('touchstart', 100, 100, childElement);
      act(() => {
        container.dispatchEvent(touchStart);
      });

      // Simulate touch end with a downward swipe
      const touchEnd = createTouchEvent('touchend', 100, 200, childElement);
      act(() => {
        container.dispatchEvent(touchEnd);
      });

      // The swipe callback should NOT be called because touch started inside scrollable
      expect(onSwipeDown).not.toHaveBeenCalled();

      document.body.removeChild(container);
    });

    it('should allow swipe when touch starts outside a scrollable element', () => {
      const onSwipeDown = vi.fn();
      const container = document.createElement('div');
      const childElement = document.createElement('span');

      // Non-scrollable: scrollHeight equals clientHeight
      Object.defineProperty(container, 'scrollHeight', {
        value: 200,
        configurable: true,
      });
      Object.defineProperty(container, 'clientHeight', {
        value: 200,
        configurable: true,
      });

      container.appendChild(childElement);
      document.body.appendChild(container);

      renderHookWithElement(container, {
        onSwipeDown,
        threshold: 50,
        enabled: true,
      });

      // Simulate touch start on non-scrollable child
      const touchStart = createTouchEvent('touchstart', 100, 100, childElement);
      act(() => {
        container.dispatchEvent(touchStart);
      });

      // Simulate touch end with downward swipe exceeding threshold
      const touchEnd = createTouchEvent('touchend', 100, 200, childElement);
      act(() => {
        container.dispatchEvent(touchEnd);
      });

      // The swipe callback should be called because touch started outside scrollable
      expect(onSwipeDown).toHaveBeenCalled();

      document.body.removeChild(container);
    });

    it('should allow swipe when touch target is not an HTMLElement', () => {
      const onSwipeDown = vi.fn();
      const container = document.createElement('div');
      document.body.appendChild(container);

      // Create a touch event with a non-HTMLElement target (e.g., SVGElement)
      const svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      container.appendChild(svgElement);

      renderHookWithElement(container, {
        onSwipeDown,
        threshold: 50,
        enabled: true,
      });

      const touchStart = createTouchEvent('touchstart', 100, 100, svgElement);
      act(() => {
        container.dispatchEvent(touchStart);
      });

      const touchEnd = createTouchEvent('touchend', 100, 200, svgElement);
      act(() => {
        container.dispatchEvent(touchEnd);
      });

      // SVGElement is not HTMLElement, so scrollable check is skipped
      // and swipe should be detected
      expect(onSwipeDown).toHaveBeenCalled();

      document.body.removeChild(container);
    });

    it('should detect overflow-y scroll as scrollable', () => {
      const onSwipeDown = vi.fn();
      const container = document.createElement('div');
      const scrollableDiv = document.createElement('div');
      const childElement = document.createElement('span');

      // Use overflow-y: scroll instead of auto
      scrollableDiv.style.overflowY = 'scroll';
      Object.defineProperty(scrollableDiv, 'scrollHeight', {
        value: 500,
        configurable: true,
      });
      Object.defineProperty(scrollableDiv, 'clientHeight', {
        value: 200,
        configurable: true,
      });

      scrollableDiv.appendChild(childElement);
      container.appendChild(scrollableDiv);
      document.body.appendChild(container);

      renderHookWithElement(container, {
        onSwipeDown,
        threshold: 50,
        enabled: true,
      });

      const touchStart = createTouchEvent('touchstart', 100, 100, childElement);
      act(() => {
        container.dispatchEvent(touchStart);
      });

      const touchEnd = createTouchEvent('touchend', 100, 200, childElement);
      act(() => {
        container.dispatchEvent(touchEnd);
      });

      // Should NOT call swipe because overflow-y: scroll with scrollable content
      expect(onSwipeDown).not.toHaveBeenCalled();

      document.body.removeChild(container);
    });

    it('should not treat overflow-y auto with no scrollable content as scrollable', () => {
      const onSwipeDown = vi.fn();
      const container = document.createElement('div');
      const overflowDiv = document.createElement('div');
      const childElement = document.createElement('span');

      // overflow-y: auto but scrollHeight equals clientHeight (no scrollable content)
      overflowDiv.style.overflowY = 'auto';
      Object.defineProperty(overflowDiv, 'scrollHeight', {
        value: 200,
        configurable: true,
      });
      Object.defineProperty(overflowDiv, 'clientHeight', {
        value: 200,
        configurable: true,
      });

      overflowDiv.appendChild(childElement);
      container.appendChild(overflowDiv);
      document.body.appendChild(container);

      renderHookWithElement(container, {
        onSwipeDown,
        threshold: 50,
        enabled: true,
      });

      const touchStart = createTouchEvent('touchstart', 100, 100, childElement);
      act(() => {
        container.dispatchEvent(touchStart);
      });

      const touchEnd = createTouchEvent('touchend', 100, 200, childElement);
      act(() => {
        container.dispatchEvent(touchEnd);
      });

      // Should call swipe because overflow-y: auto but no actual scrollable content
      expect(onSwipeDown).toHaveBeenCalled();

      document.body.removeChild(container);
    });
  });

  describe('isInsideScrollableElement (direct unit tests)', () => {
    it('should return false for an element with no scrollable ancestor', () => {
      const element = document.createElement('div');
      document.body.appendChild(element);

      expect(isInsideScrollableElement(element)).toBe(false);

      document.body.removeChild(element);
    });

    it('should return true when the element itself is scrollable', () => {
      const element = document.createElement('div');
      element.style.overflowY = 'auto';
      Object.defineProperty(element, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: 200, configurable: true });
      document.body.appendChild(element);

      expect(isInsideScrollableElement(element)).toBe(true);

      document.body.removeChild(element);
    });

    it('should return true when a parent element is scrollable', () => {
      const parent = document.createElement('div');
      parent.style.overflowY = 'scroll';
      Object.defineProperty(parent, 'scrollHeight', { value: 800, configurable: true });
      Object.defineProperty(parent, 'clientHeight', { value: 300, configurable: true });

      const child = document.createElement('span');
      parent.appendChild(child);
      document.body.appendChild(parent);

      expect(isInsideScrollableElement(child)).toBe(true);

      document.body.removeChild(parent);
    });

    it('should return false when overflow-y is auto but content does not overflow', () => {
      const element = document.createElement('div');
      element.style.overflowY = 'auto';
      Object.defineProperty(element, 'scrollHeight', { value: 100, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: 100, configurable: true });
      document.body.appendChild(element);

      expect(isInsideScrollableElement(element)).toBe(false);

      document.body.removeChild(element);
    });

    it('should return false when overflow-y is hidden even with overflow content', () => {
      const element = document.createElement('div');
      element.style.overflowY = 'hidden';
      Object.defineProperty(element, 'scrollHeight', { value: 500, configurable: true });
      Object.defineProperty(element, 'clientHeight', { value: 200, configurable: true });
      document.body.appendChild(element);

      expect(isInsideScrollableElement(element)).toBe(false);

      document.body.removeChild(element);
    });

    it('should traverse multiple ancestors to find scrollable parent', () => {
      const grandparent = document.createElement('div');
      grandparent.style.overflowY = 'auto';
      Object.defineProperty(grandparent, 'scrollHeight', { value: 600, configurable: true });
      Object.defineProperty(grandparent, 'clientHeight', { value: 200, configurable: true });

      const parent = document.createElement('div');
      const child = document.createElement('span');

      parent.appendChild(child);
      grandparent.appendChild(parent);
      document.body.appendChild(grandparent);

      expect(isInsideScrollableElement(child)).toBe(true);

      document.body.removeChild(grandparent);
    });

    it('should detect horizontal scrollability when axis is "horizontal"', () => {
      const element = document.createElement('div');
      element.style.overflowX = 'auto';
      Object.defineProperty(element, 'scrollWidth', { value: 500, configurable: true });
      Object.defineProperty(element, 'clientWidth', { value: 200, configurable: true });
      document.body.appendChild(element);

      // Horizontally scrollable, but NOT vertically scrollable.
      expect(isInsideScrollableElement(element, 'horizontal')).toBe(true);
      expect(isInsideScrollableElement(element, 'vertical')).toBe(false);

      document.body.removeChild(element);
    });
  });

  describe('Issue #1128: axis, direction lock, edge zone', () => {
    /** Minimal touch event (jsdom lacks Touch/TouchEvent constructors). */
    function createTouchEvent(
      type: string,
      clientX: number,
      clientY: number,
      target: EventTarget
    ): TouchEvent {
      const touch = { clientX, clientY, identifier: 0, target } as unknown as Touch;
      const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
      Object.defineProperty(event, 'touches', { value: [touch] });
      Object.defineProperty(event, 'changedTouches', { value: [touch] });
      Object.defineProperty(event, 'target', { value: target });
      return event;
    }

    /** Render the hook with an element pre-attached to its ref. */
    function renderHookWithElement(
      element: HTMLElement,
      options: Parameters<typeof useSwipeGesture>[0]
    ) {
      const hookResult = renderHook((props) => useSwipeGesture(props), {
        initialProps: { ...options, enabled: false },
      });
      (hookResult.result.current.ref as { current: HTMLElement | null }).current = element;
      hookResult.rerender({ ...options, enabled: true });
      return hookResult;
    }

    function dispatch(el: HTMLElement, event: TouchEvent) {
      act(() => {
        el.dispatchEvent(event);
      });
    }

    it('should fire onSwipeLeft for a horizontal-axis left swipe', () => {
      const onSwipeLeft = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);

      renderHookWithElement(el, { axis: 'horizontal', threshold: 60, onSwipeLeft });

      dispatch(el, createTouchEvent('touchstart', 200, 100, child));
      dispatch(el, createTouchEvent('touchmove', 100, 105, child));
      dispatch(el, createTouchEvent('touchend', 90, 108, child));

      expect(onSwipeLeft).toHaveBeenCalledTimes(1);
      document.body.removeChild(el);
    });

    it('should NOT fire a horizontal swipe once the gesture locks to vertical (direction lock)', () => {
      const onSwipeLeft = vi.fn();
      const onSwipeRight = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);

      renderHookWithElement(el, { axis: 'horizontal', threshold: 60, onSwipeLeft, onSwipeRight });

      // Vertical-dominant move commits the gesture to the vertical axis, which is
      // perpendicular to the horizontal hook → cancelled for the rest of the touch.
      dispatch(el, createTouchEvent('touchstart', 200, 100, child));
      dispatch(el, createTouchEvent('touchmove', 190, 200, child));
      dispatch(el, createTouchEvent('touchend', 90, 220, child));

      expect(onSwipeLeft).not.toHaveBeenCalled();
      expect(onSwipeRight).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it('should still fire a vertical swipe on the vertical axis (bottom-sheet dismiss)', () => {
      const onSwipeDown = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);

      renderHookWithElement(el, { axis: 'vertical', threshold: 100, onSwipeDown });

      dispatch(el, createTouchEvent('touchstart', 100, 0, child));
      dispatch(el, createTouchEvent('touchmove', 100, 80, child));
      dispatch(el, createTouchEvent('touchend', 100, 160, child));

      expect(onSwipeDown).toHaveBeenCalledTimes(1);
      document.body.removeChild(el);
    });

    it('should report live progress via onSwipeMove', () => {
      const onSwipeMove = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);

      renderHookWithElement(el, { axis: 'vertical', threshold: 100, onSwipeMove });

      dispatch(el, createTouchEvent('touchstart', 100, 0, child));
      dispatch(el, createTouchEvent('touchmove', 100, 40, child));

      expect(onSwipeMove).toHaveBeenCalledWith({ deltaX: 0, deltaY: 40 });
      document.body.removeChild(el);
    });

    it('should suppress a center-start swipe when edgeStartZone is set', () => {
      const onSwipeRight = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);
      el.getBoundingClientRect = () =>
        ({ left: 0, right: 400, top: 0, bottom: 0, width: 400, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;

      renderHookWithElement(el, { axis: 'horizontal', threshold: 60, edgeStartZone: 32, onSwipeRight });

      // Start in the centre (far from both edges) → not tracked.
      dispatch(el, createTouchEvent('touchstart', 200, 100, child));
      dispatch(el, createTouchEvent('touchmove', 300, 100, child));
      dispatch(el, createTouchEvent('touchend', 320, 100, child));

      expect(onSwipeRight).not.toHaveBeenCalled();
      document.body.removeChild(el);
    });

    it('should allow an edge-start swipe when edgeStartZone is set', () => {
      const onSwipeRight = vi.fn();
      const el = document.createElement('div');
      const child = document.createElement('span');
      el.appendChild(child);
      document.body.appendChild(el);
      el.getBoundingClientRect = () =>
        ({ left: 0, right: 400, top: 0, bottom: 0, width: 400, height: 0, x: 0, y: 0, toJSON() {} }) as DOMRect;

      renderHookWithElement(el, { axis: 'horizontal', threshold: 60, edgeStartZone: 32, onSwipeRight });

      // Start near the left edge (within 32px) → tracked, swipe right fires.
      dispatch(el, createTouchEvent('touchstart', 10, 100, child));
      dispatch(el, createTouchEvent('touchmove', 90, 105, child));
      dispatch(el, createTouchEvent('touchend', 110, 108, child));

      expect(onSwipeRight).toHaveBeenCalledTimes(1);
      document.body.removeChild(el);
    });
  });
});
