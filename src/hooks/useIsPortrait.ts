/**
 * useIsPortrait Hook (Issue #1519)
 *
 * Reports whether the viewport is in portrait orientation via `matchMedia`, so
 * the value tracks device rotation. The previous inline
 * `window.innerHeight > window.innerWidth` check was read during render and
 * never re-evaluated, leaving rotated devices on a stale layout.
 *
 * Follows the same seed/layout-effect shape as `useIsMobile` (Issue #1126):
 * the seed matches SSR (`false`) and the correction is flushed before the first
 * paint, so no rotation flash and no hydration mismatch.
 *
 * @module hooks/useIsPortrait
 */

'use client';

import { useState, useEffect, useLayoutEffect } from 'react';

const useIsomorphicLayoutEffect =
  typeof window !== 'undefined' ? useLayoutEffect : useEffect;

const PORTRAIT_QUERY = '(orientation: portrait)';

/**
 * @returns whether the viewport is currently portrait-oriented
 */
export function useIsPortrait(): boolean {
  const [isPortrait, setIsPortrait] = useState(false);

  useIsomorphicLayoutEffect(() => {
    const mediaQuery = window.matchMedia(PORTRAIT_QUERY);
    setIsPortrait(mediaQuery.matches);

    const handleChange = (event: MediaQueryListEvent) => {
      setIsPortrait(event.matches);
    };

    mediaQuery.addEventListener('change', handleChange);
    return () => mediaQuery.removeEventListener('change', handleChange);
  }, []);

  return isPortrait;
}

export default useIsPortrait;
