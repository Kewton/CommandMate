/**
 * BranchStatusIndicator Component
 *
 * Displays a colored dot indicating the branch's current status.
 * Includes animation for active states.
 *
 * SF1: Uses centralized status colors from @/config/status-colors
 */

'use client';

import React, { memo } from 'react';
import type { BranchStatus } from '@/types/sidebar';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';

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
}: BranchStatusIndicatorProps) {
  const config = SIDEBAR_STATUS_CONFIG[status];
  // Issue #867: prefer the caller-supplied breakdown label when present.
  const accessibleLabel = label ?? config.label;

  if (config.type === 'spinner') {
    return (
      <span
        data-testid="status-indicator"
        className={`
          w-3 h-3 rounded-full flex-shrink-0
          border-2 border-t-transparent
          ${config.className}
          animate-spin
        `}
        title={accessibleLabel}
        aria-label={accessibleLabel}
      />
    );
  }

  return (
    <span
      data-testid="status-indicator"
      className={`
        w-3 h-3 rounded-full flex-shrink-0
        ${config.className}
      `}
      title={accessibleLabel}
      aria-label={accessibleLabel}
    />
  );
});
