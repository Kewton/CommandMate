/**
 * Route-segment Suspense fallback (Issue #1118).
 * Thin by design — see RouteLoading for rationale.
 */

import { RouteLoading } from '@/components/common/RouteLoading';

export default function Loading() {
  return <RouteLoading />;
}
