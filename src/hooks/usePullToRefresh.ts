/**
 * usePullToRefresh Hook (Issue #1128)
 *
 * Self-implemented pull-to-refresh for scrollable list surfaces (Sessions /
 * Repositories). Fires only when the container is scrolled to the very top and
 * suppresses the browser's native pull-to-refresh (via preventDefault on the
 * pulling touchmove) so there is never a double refresh. Pair the container with
 * `overscroll-behavior-y: contain` for the same reason.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

export interface UsePullToRefreshOptions {
  /** Invoked when a pull past the threshold is released. May be async. */
  onRefresh: () => void | Promise<void>;
  /** Whether the gesture is active (default: true). */
  enabled?: boolean;
  /** Pull distance (px) required to trigger a refresh (default: 64). */
  threshold?: number;
  /** Maximum visual pull distance (px) after resistance (default: 96). */
  maxPull?: number;
  /** Drag resistance factor applied to raw finger travel (default: 0.5). */
  resistance?: number;
}

export interface UsePullToRefreshReturn {
  /** Attach to the scrollable container element. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  /** Current (resisted) pull distance in pixels. */
  pullDistance: number;
  /** Whether a refresh is in flight. */
  isRefreshing: boolean;
  /** Whether the user is actively pulling. */
  isPulling: boolean;
}

/** Default pull distance to trigger a refresh. */
const DEFAULT_THRESHOLD = 64;
/** Default visual pull cap. */
const DEFAULT_MAX_PULL = 96;
/** Default drag resistance. */
const DEFAULT_RESISTANCE = 0.5;

/**
 * Hook implementing a top-anchored pull-to-refresh gesture.
 */
export function usePullToRefresh(options: UsePullToRefreshOptions): UsePullToRefreshReturn {
  const {
    onRefresh,
    enabled = true,
    threshold = DEFAULT_THRESHOLD,
    maxPull = DEFAULT_MAX_PULL,
    resistance = DEFAULT_RESISTANCE,
  } = options;

  const containerRef = useRef<HTMLDivElement>(null);
  const [pullDistance, setPullDistance] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isPulling, setIsPulling] = useState(false);

  // Gesture bookkeeping kept in refs so the (stable) native listeners always
  // read current values without re-binding on every render.
  const startYRef = useRef<number | null>(null);
  const pullRef = useRef(0);
  const isRefreshingRef = useRef(false);
  isRefreshingRef.current = isRefreshing;

  const resetPull = useCallback(() => {
    startYRef.current = null;
    pullRef.current = 0;
    setPullDistance(0);
    setIsPulling(false);
  }, []);

  const handleTouchStart = useCallback((e: TouchEvent) => {
    if (!enabled || isRefreshingRef.current) return;
    const el = containerRef.current;
    // Only arm the gesture when the list is scrolled to the very top.
    if (!el || el.scrollTop > 0) return;
    startYRef.current = e.touches[0].clientY;
    pullRef.current = 0;
  }, [enabled]);

  const handleTouchMove = useCallback((e: TouchEvent) => {
    if (startYRef.current === null) return;
    const el = containerRef.current;
    if (!el) return;

    // Content scrolled away from the top mid-gesture — hand back to native scroll.
    if (el.scrollTop > 0) {
      resetPull();
      return;
    }

    const delta = e.touches[0].clientY - startYRef.current;
    if (delta <= 0) {
      // Upward drag: let native scrolling take over.
      if (pullRef.current !== 0) {
        pullRef.current = 0;
        setPullDistance(0);
        setIsPulling(false);
      }
      return;
    }

    // Downward pull at the top: suppress native scroll / browser PTR and drive
    // our own indicator with resistance + a cap.
    if (e.cancelable) e.preventDefault();
    const pull = Math.min(delta * resistance, maxPull);
    pullRef.current = pull;
    setPullDistance(pull);
    setIsPulling(true);
  }, [resistance, maxPull, resetPull]);

  const runRefresh = useCallback(async () => {
    setIsRefreshing(true);
    setIsPulling(false);
    // Hold the indicator at the threshold while the refresh runs.
    setPullDistance(threshold);
    try {
      await Promise.resolve(onRefresh());
    } finally {
      setIsRefreshing(false);
      setPullDistance(0);
    }
  }, [onRefresh, threshold]);

  const handleTouchEnd = useCallback(() => {
    if (startYRef.current === null) return;
    const shouldRefresh = pullRef.current >= threshold && !isRefreshingRef.current;
    startYRef.current = null;
    pullRef.current = 0;
    if (shouldRefresh) {
      void runRefresh();
    } else {
      setPullDistance(0);
      setIsPulling(false);
    }
  }, [threshold, runRefresh]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    // touchmove must be non-passive so preventDefault can suppress native PTR.
    el.addEventListener('touchstart', handleTouchStart, { passive: true });
    el.addEventListener('touchmove', handleTouchMove, { passive: false });
    el.addEventListener('touchend', handleTouchEnd, { passive: true });
    el.addEventListener('touchcancel', handleTouchEnd, { passive: true });

    return () => {
      el.removeEventListener('touchstart', handleTouchStart);
      el.removeEventListener('touchmove', handleTouchMove);
      el.removeEventListener('touchend', handleTouchEnd);
      el.removeEventListener('touchcancel', handleTouchEnd);
    };
  }, [handleTouchStart, handleTouchMove, handleTouchEnd]);

  return { containerRef, pullDistance, isRefreshing, isPulling };
}

export default usePullToRefresh;
