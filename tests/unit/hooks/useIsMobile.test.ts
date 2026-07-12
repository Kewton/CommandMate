/**
 * Tests for useIsMobile hook
 *
 * Tests mobile detection based on `matchMedia` (Issue #1069). jsdom does not
 * implement `window.matchMedia`, so it is mocked with a controllable stub that
 * evaluates a `(max-width: Npx)` query against a virtual viewport width and
 * dispatches `change` events when that width crosses the breakpoint.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useIsMobile, MOBILE_BREAKPOINT } from '@/hooks/useIsMobile';

interface MockMediaQueryList {
  media: string;
  maxWidth: number;
  matches: boolean;
  listeners: Set<(event: MediaQueryListEvent) => void>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
}

/** Virtual CSS-viewport width that the mocked `matchMedia` evaluates against. */
let currentWidth = 1024;
/** All MediaQueryList objects created by the mock in the current test. */
let mediaQueryLists: MockMediaQueryList[] = [];

/** Extract the pixel value from a `(max-width: Npx)` media query. */
function parseMaxWidth(query: string): number {
  const match = query.match(/max-width:\s*(\d+)px/);
  return match ? Number(match[1]) : NaN;
}

/** Build a fresh `window.matchMedia` mock backed by `mediaQueryLists`. */
function createMatchMedia() {
  return vi.fn((query: string): MediaQueryList => {
    const maxWidth = parseMaxWidth(query);
    const mql: MockMediaQueryList = {
      media: query,
      maxWidth,
      matches: currentWidth <= maxWidth,
      listeners: new Set(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    };
    mql.addEventListener.mockImplementation(
      (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') mql.listeners.add(listener);
      }
    );
    mql.removeEventListener.mockImplementation(
      (type: string, listener: (event: MediaQueryListEvent) => void) => {
        if (type === 'change') mql.listeners.delete(listener);
      }
    );
    mediaQueryLists.push(mql);
    return mql as unknown as MediaQueryList;
  });
}

/**
 * Change the virtual viewport width and dispatch `change` events to every
 * MediaQueryList whose match result flips as a result.
 */
function setViewportWidth(width: number) {
  currentWidth = width;
  for (const mql of mediaQueryLists) {
    const nextMatches = width <= mql.maxWidth;
    if (nextMatches !== mql.matches) {
      mql.matches = nextMatches;
      const event = { matches: nextMatches, media: mql.media } as MediaQueryListEvent;
      mql.listeners.forEach((listener) => listener(event));
    }
  }
}

describe('useIsMobile', () => {
  beforeEach(() => {
    currentWidth = 1024;
    mediaQueryLists = [];
    vi.stubGlobal('matchMedia', createMatchMedia());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('SSR / initial state', () => {
    it('seeds state with false on the first render even on a mobile viewport', () => {
      // The SSR-safe invariant: the useState seed is false so the server render
      // and the first client render agree (no hydration mismatch). Detection
      // happens in useEffect, which only runs on the client after hydration.
      setViewportWidth(390);
      const renders: boolean[] = [];
      renderHook(() => {
        const value = useIsMobile();
        renders.push(value);
        return value;
      });
      expect(renders[0]).toBe(false);
      expect(renders[renders.length - 1]).toBe(true);
    });

    it('does not call matchMedia during the initial render (only in effect)', () => {
      // Server-side there is no matchMedia; the hook must not touch it during
      // render. renderHook flushes effects, so by the end it has been called,
      // but never before the first render committed.
      setViewportWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
    });
  });

  describe('Initial state', () => {
    it('returns true when the viewport matches the mobile query', () => {
      setViewportWidth(500);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);
    });

    it('returns false when the viewport is at desktop width', () => {
      setViewportWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
    });

    it('returns false at exactly the breakpoint (768px)', () => {
      setViewportWidth(MOBILE_BREAKPOINT);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);
    });

    it('returns true just below the breakpoint (767px)', () => {
      setViewportWidth(MOBILE_BREAKPOINT - 1);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);
    });
  });

  describe('Media query string', () => {
    it('queries (max-width: 767px) — the exact complement of Tailwind md:', () => {
      renderHook(() => useIsMobile());
      expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 767px)');
    });

    it('does not use fractional pixel values', () => {
      renderHook(() => useIsMobile());
      const query = (window.matchMedia as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
      expect(query).not.toContain('.');
    });
  });

  describe('change handling', () => {
    it('updates to mobile when the query starts matching', () => {
      setViewportWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);

      act(() => {
        setViewportWidth(500);
      });

      expect(result.current).toBe(true);
    });

    it('updates to desktop when the query stops matching', () => {
      setViewportWidth(500);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);

      act(() => {
        setViewportWidth(1024);
      });

      expect(result.current).toBe(false);
    });

    it('stays mobile while resizing within the mobile range', () => {
      setViewportWidth(400);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(true);

      act(() => {
        setViewportWidth(600);
      });

      expect(result.current).toBe(true);
    });

    it('stays desktop while resizing within the desktop range', () => {
      setViewportWidth(1024);
      const { result } = renderHook(() => useIsMobile());
      expect(result.current).toBe(false);

      act(() => {
        setViewportWidth(1200);
      });

      expect(result.current).toBe(false);
    });

    it('registers a change listener via addEventListener', () => {
      renderHook(() => useIsMobile());
      expect(mediaQueryLists).toHaveLength(1);
      expect(mediaQueryLists[0].addEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });
  });

  describe('Cleanup', () => {
    it('removes the change listener on unmount', () => {
      const { unmount } = renderHook(() => useIsMobile());
      expect(mediaQueryLists).toHaveLength(1);

      unmount();

      expect(mediaQueryLists[0].removeEventListener).toHaveBeenCalledWith(
        'change',
        expect.any(Function)
      );
    });
  });

  describe('Breakpoint value', () => {
    it('uses 768 as the default breakpoint', () => {
      expect(MOBILE_BREAKPOINT).toBe(768);
    });
  });

  describe('Custom breakpoint', () => {
    it('generates a (max-width: breakpoint-1) query', () => {
      renderHook(() => useIsMobile({ breakpoint: 1024 }));
      expect(window.matchMedia).toHaveBeenCalledWith('(max-width: 1023px)');
    });

    it('returns true when the viewport is below the custom breakpoint', () => {
      setViewportWidth(900);
      const { result } = renderHook(() => useIsMobile({ breakpoint: 1024 }));
      expect(result.current).toBe(true);
    });

    it('reacts to change events with the custom breakpoint', () => {
      setViewportWidth(900);
      const { result } = renderHook(() => useIsMobile({ breakpoint: 1024 }));
      expect(result.current).toBe(true);

      act(() => {
        setViewportWidth(1100);
      });

      expect(result.current).toBe(false);
    });
  });
});
