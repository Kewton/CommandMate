/**
 * useIsMobile Hook
 *
 * Detects if the current viewport is mobile-sized using `matchMedia`, so the
 * breakpoint is evaluated against the CSS viewport — exactly like Tailwind's
 * `md:` — rather than the layout width, which can diverge from the CSS viewport
 * under zoom, WebView, and device-emulation environments (Issue #1069).
 *
 * SSR-flip flash fix (Issue #1126): the seed stays `false` so the server render
 * and the first client render agree (no hydration mismatch), but the correction
 * runs in a *layout* effect. `useLayoutEffect` fires after commit yet BEFORE the
 * browser paints, so the state update it schedules is flushed in the same frame
 * — the accurate `isMobile` value is applied before the first paint. On a mobile
 * viewport the desktop tree is therefore replaced before it is ever painted,
 * eliminating the desktop→mobile flip flash without any UA sniffing or
 * double-mounting of the heavy `WorktreeDetail` tree (the discarded branch is
 * torn down within the same commit, so its passive polling effects never run).
 */

'use client';

import { useState, useEffect, useLayoutEffect } from 'react';

/**
 * `useLayoutEffect` is a no-op on the server and React warns when it is called
 * during server rendering. Fall back to `useEffect` there to keep SSR
 * warning-free, while preserving the pre-paint timing on the client where the
 * flash-elimination actually matters.
 */
const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

/**
 * Default mobile breakpoint (768px - matches Tailwind's md breakpoint)
 */
export const MOBILE_BREAKPOINT = 768;

/**
 * Options for useIsMobile hook
 */
export interface UseIsMobileOptions {
  /** Custom breakpoint in pixels (default: 768) */
  breakpoint?: number;
}

/**
 * Custom hook for detecting mobile viewport
 *
 * @param options - Configuration options
 * @returns boolean indicating if viewport is mobile-sized
 *
 * @example
 * ```tsx
 * function ResponsiveLayout() {
 *   const isMobile = useIsMobile();
 *
 *   return isMobile ? <MobileLayout /> : <DesktopLayout />;
 * }
 * ```
 *
 * @example
 * ```tsx
 * // With custom breakpoint
 * function ResponsiveLayout() {
 *   const isTablet = useIsMobile({ breakpoint: 1024 });
 *
 *   return isTablet ? <TabletLayout /> : <DesktopLayout />;
 * }
 * ```
 */
export function useIsMobile(options: UseIsMobileOptions = {}): boolean {
  const { breakpoint = MOBILE_BREAKPOINT } = options;

  // IMPORTANT: Always start with false to match SSR and avoid hydration mismatch.
  // The actual mobile detection happens in the layout effect below, which is
  // flushed before the first browser paint (Issue #1126).
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useIsomorphicLayoutEffect(() => {
    // `max-width: breakpoint - 1` is the exact complement of Tailwind's `md:`
    // (`min-width: breakpoint`); for the default 768 this is `max-width: 767px`.
    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);

    // Sync state on mount, before paint, so the correct tree is the first frame.
    setIsMobile(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsMobile(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);

    return () => {
      mediaQuery.removeEventListener('change', handleChange);
    };
  }, [breakpoint]);

  return isMobile;
}
