/**
 * PullToRefresh Component (Issue #1128)
 *
 * Scrollable wrapper that adds a top-anchored pull-to-refresh gesture on touch
 * devices. It owns the scroll container so the gesture can read `scrollTop` and
 * suppress the browser's native pull-to-refresh (`overscroll-behavior-y:
 * contain` + preventDefault inside the hook) — no double refresh.
 */

'use client';

import React from 'react';
import { Spinner } from '@/components/ui';
import { cn } from '@/lib/utils/cn';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';

/** Pull distance (px) required to trigger a refresh. */
const PULL_THRESHOLD = 64;

export interface PullToRefreshProps {
  /** Called when a pull past the threshold is released. May be async. */
  onRefresh: () => void | Promise<void>;
  /** Whether the gesture is active (default: true). Gate to mobile if desired. */
  enabled?: boolean;
  /** Classes applied to the scroll container. */
  className?: string;
  /** Scrollable content. */
  children: React.ReactNode;
}

/**
 * Wraps content in a scroll container with a pull-to-refresh spinner.
 */
export function PullToRefresh({ onRefresh, enabled = true, className, children }: PullToRefreshProps) {
  const { containerRef, pullDistance, isRefreshing, isPulling } = usePullToRefresh({
    onRefresh,
    enabled,
    threshold: PULL_THRESHOLD,
  });

  const active = isRefreshing || pullDistance > 0;
  const indicatorOpacity = isRefreshing ? 1 : Math.min(pullDistance / PULL_THRESHOLD, 1);
  // Smooth the release/spring-back, but track the finger 1:1 while pulling.
  const contentTransition = isPulling ? 'none' : 'transform 0.2s ease-out';

  return (
    <div
      ref={containerRef}
      className={cn('relative overflow-auto', className)}
      style={{ overscrollBehaviorY: 'contain' }}
      data-testid="pull-to-refresh"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 z-10 flex justify-center"
        style={{
          transform: `translateY(${active ? Math.max(pullDistance - 24, 8) : -32}px)`,
          opacity: indicatorOpacity,
          transition: isPulling
            ? 'none'
            : 'transform 0.2s ease-out, opacity 0.2s ease-out',
        }}
        data-testid="pull-to-refresh-indicator"
        role="status"
        aria-hidden={!isRefreshing}
      >
        <Spinner size="sm" variant="accent" />
      </div>
      <div
        style={{
          transform: active ? `translateY(${pullDistance}px)` : undefined,
          transition: contentTransition,
        }}
      >
        {children}
      </div>
    </div>
  );
}

export default PullToRefresh;
