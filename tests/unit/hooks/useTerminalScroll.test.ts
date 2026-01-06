/**
 * Tests for useTerminalScroll hook
 *
 * Tests the auto-scroll functionality for terminal display
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalScroll } from '@/hooks/useTerminalScroll';

describe('useTerminalScroll', () => {
  // Mock ref element
  let mockElement: HTMLDivElement;

  beforeEach(() => {
    mockElement = document.createElement('div');
    // Set up scroll properties
    Object.defineProperty(mockElement, 'scrollHeight', { value: 1000, writable: true });
    Object.defineProperty(mockElement, 'clientHeight', { value: 200, writable: true });
    Object.defineProperty(mockElement, 'scrollTop', { value: 0, writable: true });
    mockElement.scrollTo = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Initial state', () => {
    it('should have autoScroll enabled by default', () => {
      const { result } = renderHook(() => useTerminalScroll());
      expect(result.current.autoScroll).toBe(true);
    });

    it('should return a ref object', () => {
      const { result } = renderHook(() => useTerminalScroll());
      expect(result.current.scrollRef).toBeDefined();
      expect(result.current.scrollRef.current).toBeNull();
    });

    it('should provide scrollToBottom function', () => {
      const { result } = renderHook(() => useTerminalScroll());
      expect(typeof result.current.scrollToBottom).toBe('function');
    });

    it('should provide setAutoScroll function', () => {
      const { result } = renderHook(() => useTerminalScroll());
      expect(typeof result.current.setAutoScroll).toBe('function');
    });
  });

  describe('setAutoScroll', () => {
    it('should update autoScroll state when called', () => {
      const { result } = renderHook(() => useTerminalScroll());

      act(() => {
        result.current.setAutoScroll(false);
      });

      expect(result.current.autoScroll).toBe(false);
    });

    it('should re-enable autoScroll', () => {
      const { result } = renderHook(() => useTerminalScroll());

      act(() => {
        result.current.setAutoScroll(false);
      });

      expect(result.current.autoScroll).toBe(false);

      act(() => {
        result.current.setAutoScroll(true);
      });

      expect(result.current.autoScroll).toBe(true);
    });
  });

  describe('scrollToBottom', () => {
    it('should call scrollTo on the element', () => {
      const { result } = renderHook(() => useTerminalScroll());

      // Manually assign the mock element to the ref
      act(() => {
        // Use Object.defineProperty to set current value on ref
        Object.defineProperty(result.current.scrollRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      act(() => {
        result.current.scrollToBottom();
      });

      expect(mockElement.scrollTo).toHaveBeenCalledWith({
        top: mockElement.scrollHeight,
        behavior: 'smooth',
      });
    });

    it('should not throw when ref is null', () => {
      const { result } = renderHook(() => useTerminalScroll());

      expect(() => {
        act(() => {
          result.current.scrollToBottom();
        });
      }).not.toThrow();
    });

    it('should re-enable autoScroll when scrollToBottom is called', () => {
      const { result } = renderHook(() => useTerminalScroll());

      // Disable auto-scroll
      act(() => {
        result.current.setAutoScroll(false);
      });

      expect(result.current.autoScroll).toBe(false);

      // Set ref
      act(() => {
        Object.defineProperty(result.current.scrollRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Call scrollToBottom
      act(() => {
        result.current.scrollToBottom();
      });

      expect(result.current.autoScroll).toBe(true);
    });
  });

  describe('User scroll detection', () => {
    it('should disable autoScroll when user scrolls up', () => {
      const { result } = renderHook(() => useTerminalScroll());

      // Setup mock element
      act(() => {
        Object.defineProperty(result.current.scrollRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Initially autoScroll is true
      expect(result.current.autoScroll).toBe(true);

      // Simulate user scrolling up (not at bottom)
      Object.defineProperty(mockElement, 'scrollTop', { value: 500, writable: true });

      // Trigger scroll event
      act(() => {
        result.current.handleScroll();
      });

      // Should disable auto-scroll because user is not at bottom
      expect(result.current.autoScroll).toBe(false);
    });

    it('should keep autoScroll enabled when scrolled to bottom', () => {
      const { result } = renderHook(() => useTerminalScroll());

      // Setup mock element
      act(() => {
        Object.defineProperty(result.current.scrollRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Set scrollTop to bottom (scrollHeight - clientHeight)
      Object.defineProperty(mockElement, 'scrollTop', { value: 800, writable: true });

      // Trigger scroll event
      act(() => {
        result.current.handleScroll();
      });

      // Should keep auto-scroll enabled
      expect(result.current.autoScroll).toBe(true);
    });

    it('should have a threshold tolerance for bottom detection', () => {
      const { result } = renderHook(() => useTerminalScroll());

      // Setup mock element with scrollHeight=1000, clientHeight=200
      // bottom = scrollHeight - clientHeight = 800
      act(() => {
        Object.defineProperty(result.current.scrollRef, 'current', {
          value: mockElement,
          writable: true,
        });
      });

      // Set scrollTop close to bottom (within threshold of 50px)
      Object.defineProperty(mockElement, 'scrollTop', { value: 760, writable: true });

      // Trigger scroll event
      act(() => {
        result.current.handleScroll();
      });

      // Should keep auto-scroll enabled due to threshold tolerance
      expect(result.current.autoScroll).toBe(true);
    });
  });

  describe('Dependency handling', () => {
    it('should accept initial autoScroll value', () => {
      const { result } = renderHook(() => useTerminalScroll({ initialAutoScroll: false }));
      expect(result.current.autoScroll).toBe(false);
    });

    it('should call onAutoScrollChange callback when autoScroll changes', () => {
      const onAutoScrollChange = vi.fn();
      const { result } = renderHook(() =>
        useTerminalScroll({ onAutoScrollChange })
      );

      act(() => {
        result.current.setAutoScroll(false);
      });

      expect(onAutoScrollChange).toHaveBeenCalledWith(false);
    });
  });
});
