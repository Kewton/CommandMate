/**
 * MobileHeader Component
 *
 * Mobile header for displaying worktree info and status
 */

'use client';

import { useMemo, memo } from 'react';

/**
 * Status type for worktree
 */
export type WorktreeStatus = 'idle' | 'running' | 'waiting' | 'error';

/**
 * Props for MobileHeader component
 */
export interface MobileHeaderProps {
  /** Worktree name to display */
  worktreeName: string;
  /** Current status */
  status: WorktreeStatus;
  /** Optional callback for back button */
  onBackClick?: () => void;
  /** Optional callback for menu button */
  onMenuClick?: () => void;
}

/** Common SVG icon props */
interface IconProps {
  /** SVG path d attribute */
  path: string;
  /** Icon size class (default: w-6 h-6) */
  className?: string;
}

/**
 * Base icon component to reduce SVG attribute repetition
 */
const Icon = memo(function Icon({ path, className = 'w-6 h-6' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={path}
      />
    </svg>
  );
});

/** Icon path definitions */
const ICON_PATHS = {
  back: 'M15 19l-7-7 7-7',
  menu: 'M4 6h16M4 12h16M4 18h16',
} as const;

/**
 * Status indicator configuration
 */
const STATUS_CONFIG: Record<
  WorktreeStatus,
  { className: string; label: string }
> = {
  idle: {
    className: 'bg-gray-400',
    label: 'Idle',
  },
  running: {
    className: 'bg-green-500 animate-pulse',
    label: 'Running',
  },
  waiting: {
    className: 'bg-yellow-500',
    label: 'Waiting for response',
  },
  error: {
    className: 'bg-red-500',
    label: 'Error',
  },
};

/**
 * MobileHeader - Header for mobile view
 *
 * Displays worktree name, status indicator, and optional navigation buttons.
 * Respects safe area insets for notched devices.
 */
export function MobileHeader({
  worktreeName,
  status,
  onBackClick,
  onMenuClick,
}: MobileHeaderProps) {
  /**
   * Status indicator configuration
   */
  const statusConfig = useMemo(() => STATUS_CONFIG[status], [status]);

  return (
    <header
      data-testid="mobile-header"
      role="banner"
      className="fixed top-0 inset-x-0 bg-white border-b border-gray-200 shadow-sm pt-safe z-40"
    >
      <div className="flex items-center justify-between h-14 px-4">
        {/* Left section: Back button or spacer */}
        <div className="w-10 flex-shrink-0">
          {onBackClick && (
            <button
              type="button"
              onClick={onBackClick}
              aria-label="Back"
              className="p-2 -ml-2 rounded-full hover:bg-gray-100 transition-colors"
            >
              <Icon path={ICON_PATHS.back} />
            </button>
          )}
        </div>

        {/* Center section: Worktree name and status */}
        <div className="flex-1 flex items-center justify-center min-w-0 px-2">
          {/* Status indicator */}
          <span
            data-testid="status-indicator"
            aria-label={statusConfig.label}
            className={`w-2 h-2 rounded-full mr-2 flex-shrink-0 ${statusConfig.className}`}
          />

          {/* Worktree name */}
          <h1
            role="heading"
            data-testid="worktree-name"
            title={worktreeName}
            className="text-sm font-medium text-gray-900 truncate text-center"
          >
            {worktreeName}
          </h1>
        </div>

        {/* Right section: Menu button or spacer */}
        <div className="w-10 flex-shrink-0 flex justify-end">
          {onMenuClick && (
            <button
              type="button"
              onClick={onMenuClick}
              aria-label="Menu"
              className="p-2 -mr-2 rounded-full hover:bg-gray-100 transition-colors"
            >
              <Icon path={ICON_PATHS.menu} />
            </button>
          )}
        </div>
      </div>
    </header>
  );
}

export default MobileHeader;
