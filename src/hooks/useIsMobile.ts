/**
 * useIsMobile Hook
 *
 * Detects if the current viewport is mobile-sized
 * Based on window width compared to a breakpoint (default: 768px)
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
    /**
     * Check if current window width is below breakpoint
     */
    const checkIsMobile = (): boolean => {
      return window.innerWidth < breakpoint;
    };

    // Update state on mount (after hydration is complete)
    setIsMobile(checkIsMobile());

    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [breakpoint]);

  return isMobile;
}
