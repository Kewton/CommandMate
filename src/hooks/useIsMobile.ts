/**
 * useIsMobile Hook
 *
 * Detects if the current viewport is mobile-sized using `matchMedia`, so the
 * breakpoint is evaluated against the CSS viewport — exactly like Tailwind's
 * `md:` — rather than the layout width, which can diverge from the CSS viewport
 * under zoom, WebView, and device-emulation environments (Issue #1069).
 */

'use client';

import { useState, useEffect } from 'react';

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

  // IMPORTANT: Always start with false to match SSR and avoid hydration mismatch
  // The actual mobile detection happens in useEffect after hydration
  const [isMobile, setIsMobile] = useState<boolean>(false);

  useEffect(() => {
    // `max-width: breakpoint - 1` is the exact complement of Tailwind's `md:`
    // (`min-width: breakpoint`); for the default 768 this is `max-width: 767px`.
    const mediaQuery = window.matchMedia(`(max-width: ${breakpoint - 1}px)`);

    // Sync state on mount (after hydration is complete)
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
