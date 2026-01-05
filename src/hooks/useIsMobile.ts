/**
 * useIsMobile Hook
 *
 * Detects if the current viewport is mobile-sized
 * Based on window width compared to a breakpoint (default: 768px)
 */

'use client';

import { useState, useEffect, useCallback } from 'react';

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

  /**
   * Check if current window width is below breakpoint
   */
  const checkIsMobile = useCallback((): boolean => {
    if (typeof window === 'undefined') {
      // SSR: default to false (desktop)
      return false;
    }
    return window.innerWidth < breakpoint;
  }, [breakpoint]);

  const [isMobile, setIsMobile] = useState<boolean>(checkIsMobile);

  useEffect(() => {
    // Update state on mount (for SSR hydration)
    setIsMobile(checkIsMobile());

    /**
     * Handle window resize events
     */
    const handleResize = () => {
      setIsMobile(checkIsMobile());
    };

    // Add resize listener
    window.addEventListener('resize', handleResize);

    // Cleanup
    return () => {
      window.removeEventListener('resize', handleResize);
    };
  }, [checkIsMobile]);

  return isMobile;
}
