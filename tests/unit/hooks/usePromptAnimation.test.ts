/**
 * Tests for usePromptAnimation hook
 *
 * Tests the animation state management for prompt panel
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Import will be created in implementation phase
import { usePromptAnimation } from '@/hooks/usePromptAnimation';

describe('usePromptAnimation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Initial state', () => {
    it('should not render when visible is false initially', () => {
      const { result } = renderHook(() =>
        usePromptAnimation({ visible: false })
      );

      expect(result.current.shouldRender).toBe(false);
      expect(result.current.isAnimating).toBe(false);
    });

    it('should render when visible is true initially', () => {
      const { result } = renderHook(() =>
        usePromptAnimation({ visible: true })
      );

      expect(result.current.shouldRender).toBe(true);
    });
  });

  describe('Fade in animation', () => {
    it('should start rendering and animating when visible becomes true', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: false } }
      );

      expect(result.current.shouldRender).toBe(false);

      rerender({ visible: true });

      expect(result.current.shouldRender).toBe(true);
      expect(result.current.isAnimating).toBe(true);
    });

    it('should have fade-in animation class when becoming visible', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: false } }
      );

      rerender({ visible: true });

      expect(result.current.animationClass).toContain('fade-in');
    });

    it('should complete fade-in animation after duration', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible, duration: 200 }),
        { initialProps: { visible: false } }
      );

      rerender({ visible: true });
      expect(result.current.isAnimating).toBe(true);

      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.isAnimating).toBe(false);
      expect(result.current.shouldRender).toBe(true);
    });
  });

  describe('Fade out animation', () => {
    it('should start fade-out animation when visible becomes false', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: true } }
      );

      // Complete initial animation
      act(() => {
        vi.advanceTimersByTime(200);
      });

      rerender({ visible: false });

      expect(result.current.isAnimating).toBe(true);
      expect(result.current.animationClass).toContain('fade-out');
    });

    it('should stop rendering after fade-out animation completes', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible, duration: 200 }),
        { initialProps: { visible: true } }
      );

      // Complete initial animation
      act(() => {
        vi.advanceTimersByTime(200);
      });

      rerender({ visible: false });

      // During animation, should still render
      expect(result.current.shouldRender).toBe(true);

      // After animation completes
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.shouldRender).toBe(false);
      expect(result.current.isAnimating).toBe(false);
    });
  });

  describe('Custom duration', () => {
    it('should respect custom duration for fade-in', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible, duration: 500 }),
        { initialProps: { visible: false } }
      );

      rerender({ visible: true });

      act(() => {
        vi.advanceTimersByTime(499);
      });

      expect(result.current.isAnimating).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(result.current.isAnimating).toBe(false);
    });

    it('should use default duration of 200ms', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: false } }
      );

      rerender({ visible: true });

      act(() => {
        vi.advanceTimersByTime(199);
      });

      expect(result.current.isAnimating).toBe(true);

      act(() => {
        vi.advanceTimersByTime(1);
      });

      expect(result.current.isAnimating).toBe(false);
    });
  });

  describe('Rapid visibility changes', () => {
    it('should handle rapid toggle correctly', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible, duration: 200 }),
        { initialProps: { visible: false } }
      );

      // Show
      rerender({ visible: true });
      expect(result.current.shouldRender).toBe(true);

      // Hide before animation completes
      act(() => {
        vi.advanceTimersByTime(100);
      });
      rerender({ visible: false });

      // Should start fade-out
      expect(result.current.animationClass).toContain('fade-out');

      // Show again before fade-out completes
      act(() => {
        vi.advanceTimersByTime(50);
      });
      rerender({ visible: true });

      // Should be visible and animating fade-in
      expect(result.current.shouldRender).toBe(true);
      expect(result.current.animationClass).toContain('fade-in');
    });
  });

  describe('Animation classes', () => {
    it('should return appropriate CSS classes for fade-in', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: false } }
      );

      rerender({ visible: true });

      // Should contain opacity and transform transition classes
      expect(result.current.animationClass).toBeTruthy();
      expect(typeof result.current.animationClass).toBe('string');
    });

    it('should return appropriate CSS classes for fade-out', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: true } }
      );

      act(() => {
        vi.advanceTimersByTime(200);
      });

      rerender({ visible: false });

      expect(result.current.animationClass).toBeTruthy();
      expect(typeof result.current.animationClass).toBe('string');
    });

    it('should return empty class when not animating and visible', () => {
      const { result, rerender } = renderHook(
        ({ visible }) => usePromptAnimation({ visible }),
        { initialProps: { visible: true } }
      );

      // Complete initial animation
      act(() => {
        vi.advanceTimersByTime(200);
      });

      expect(result.current.animationClass).toBe('');
    });
  });
});
