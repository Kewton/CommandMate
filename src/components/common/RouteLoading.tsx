/**
 * RouteLoading Component
 * Shared route-level Suspense fallback for App Router loading.tsx files
 * (Issue #1118).
 *
 * Deliberately thin: every screen is a `'use client'` page that fetches on
 * mount, so the real loading UX lives in per-component skeletons. This
 * fallback only covers the route-segment (chunk / RSC) load and sketches a
 * generic page outline: a heading line and two content cards.
 */

import { Skeleton } from '@/components/ui/Skeleton';

export function RouteLoading() {
  return (
    <div
      className="container-custom py-8"
      role="status"
      aria-label="Loading page"
      data-testid="route-loading"
    >
      <Skeleton className="mb-6 h-8 w-48 max-w-full" />
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
        <Skeleton className="h-40 rounded-lg" />
        <Skeleton className="h-40 rounded-lg" />
      </div>
    </div>
  );
}
