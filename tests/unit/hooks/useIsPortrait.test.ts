/**
 * Tests for useIsPortrait (Issue #1519)
 *
 * The hook replaces a render-time `window.innerHeight > window.innerWidth`
 * comparison that never re-evaluated, so the point of these tests is that a
 * rotation actually reaches the consumer. Uses the shared jsdom `matchMedia`
 * stub from tests/setup.ts, which resolves orientation queries from the
 * viewport dimensions and re-evaluates on `resize`.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsPortrait } from '@/hooks/useIsPortrait';

function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, writable: true, configurable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, writable: true, configurable: true });
}

describe('useIsPortrait', () => {
  beforeEach(() => {
    setViewport(1024, 768);
  });

  it('reports portrait for a taller-than-wide viewport', () => {
    setViewport(375, 812);
    const { result } = renderHook(() => useIsPortrait());
    expect(result.current).toBe(true);
  });

  it('reports landscape for a wider-than-tall viewport', () => {
    setViewport(812, 375);
    const { result } = renderHook(() => useIsPortrait());
    expect(result.current).toBe(false);
  });

  it('follows a rotation from portrait to landscape without a remount', () => {
    setViewport(375, 812);
    const { result } = renderHook(() => useIsPortrait());
    expect(result.current).toBe(true);

    act(() => {
      setViewport(812, 375);
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current).toBe(false);
  });

  it('follows a rotation back from landscape to portrait', () => {
    setViewport(812, 375);
    const { result } = renderHook(() => useIsPortrait());
    expect(result.current).toBe(false);

    act(() => {
      setViewport(375, 812);
      window.dispatchEvent(new Event('resize'));
    });

    expect(result.current).toBe(true);
  });
});
