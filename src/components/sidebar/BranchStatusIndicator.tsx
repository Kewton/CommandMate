/**
 * BranchStatusIndicator Component
 *
 * Displays a colored dot indicating the branch's current status.
 * Includes animation for active states.
 */

'use client';

import React, { memo } from 'react';
import type { BranchStatus } from '@/types/sidebar';

// ============================================================================
// Types
// ============================================================================

/** Props for BranchStatusIndicator */
export interface BranchStatusIndicatorProps {
  /** Current branch status */
  status: BranchStatus;
}

// ============================================================================
// Configuration
// ============================================================================

/** Status configuration mapping */
interface StatusConfig {
  /** Tailwind background color class */
  color: string;
  /** Accessible label */
  label: string;
  /** Whether to animate */
  animate: boolean;
}

const statusConfig: Record<BranchStatus, StatusConfig> = {
  idle: {
    color: 'bg-gray-500',
    label: 'Idle',
    animate: false,
  },
  running: {
    color: 'bg-green-500',
    label: 'Running',
    animate: true,
  },
  waiting: {
    color: 'bg-yellow-500',
    label: 'Waiting',
    animate: true,
  },
  generating: {
    color: 'bg-blue-500',
    label: 'Generating',
    animate: true,
  },
};

// ============================================================================
// Component
// ============================================================================

/**
 * BranchStatusIndicator displays a colored status dot
 *
 * @example
 * ```tsx
 * <BranchStatusIndicator status="running" />
 * ```
 */
export const BranchStatusIndicator = memo(function BranchStatusIndicator({
  status,
}: BranchStatusIndicatorProps) {
  const config = statusConfig[status];

  return (
    <span
      data-testid="status-indicator"
      className={`
        w-3 h-3 rounded-full flex-shrink-0
        ${config.color}
        ${config.animate ? 'animate-pulse' : ''}
      `}
      title={config.label}
      aria-label={config.label}
    />
  );
});
