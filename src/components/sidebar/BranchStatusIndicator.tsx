/**
 * BranchStatusIndicator Component
 *
 * Displays a colored dot indicating the branch's current status.
 * Delegates rendering to the shared StatusDot primitive (Issue #1051): active
 * states (running/generating) glow and pulse, waiting pulses harder still
 * (Issue #1787), and the rest are static dots.
 */

'use client';

import React, { memo } from 'react';
import type { BranchStatus, BranchWaitingKind } from '@/types/sidebar';
import { StatusDot } from '@/components/ui/StatusDot';

// ============================================================================
// Types
// ============================================================================

/** Props for BranchStatusIndicator */
export interface BranchStatusIndicatorProps {
  /** Current branch status */
  status: BranchStatus;
  /**
   * Optional accessible label override (Issue #867).
   * When provided (e.g. a per-agent breakdown like "Claude: running, Codex: idle"),
   * it replaces the default status-config label for both `title` and `aria-label`.
   * Falls back to the status config label when omitted.
   */
  label?: string;
  /**
   * Kind of wait behind a `waiting` status (Issue #1787). Absent → strong
   * emphasis, which is the correct fallback for a payload that predates #1786.
   */
  waitingKind?: BranchWaitingKind | null;
}

// ============================================================================
// Component
// ============================================================================

/**
 * BranchStatusIndicator displays a colored status dot or spinner
 *
 * @example
 * ```tsx
 * <BranchStatusIndicator status="running" />
 * ```
 */
export const BranchStatusIndicator = memo(function BranchStatusIndicator({
  status,
  label,
  waitingKind,
}: BranchStatusIndicatorProps) {
  // Issue #867: `label` (per-agent breakdown) overrides the default; StatusDot
  // falls back to the status's own label when omitted.
  return (
    <StatusDot
      data-testid="status-indicator"
      status={status}
      label={label}
      waitingKind={waitingKind}
      size="lg"
    />
  );
});
