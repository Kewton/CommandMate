/**
 * BranchListItem Component
 *
 * Individual branch item in the sidebar list.
 * Shows branch name, repository, status, and unread indicator.
 */

'use client';

import React, { memo } from 'react';
import type { SidebarBranchItem, BranchStatus } from '@/types/sidebar';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';

// ============================================================================
// Types
// ============================================================================

/** Props for BranchListItem */
export interface BranchListItemProps {
  /** Branch data to display */
  branch: SidebarBranchItem;
  /** Whether this branch is currently selected */
  isSelected: boolean;
  /** Callback when branch is clicked */
  onClick: () => void;
}

// ============================================================================
// CLI Status Dot
// ============================================================================

/** Small status indicator dot for a CLI tool */
function CliStatusDot({ status, label }: { status: BranchStatus; label: string }) {
  const config = SIDEBAR_STATUS_CONFIG[status];
  const title = `${label}: ${config.label}`;

  if (config.type === 'spinner') {
    return (
      <span
        className={`w-2 h-2 rounded-full flex-shrink-0 border-2 border-t-transparent animate-spin ${config.className}`}
        title={title}
        aria-label={title}
      />
    );
  }

  return (
    <span
      className={`w-2 h-2 rounded-full flex-shrink-0 ${config.className}`}
      title={title}
      aria-label={title}
    />
  );
}

// ============================================================================
// Component
// ============================================================================

/**
 * BranchListItem displays a single branch in the sidebar
 *
 * @example
 * ```tsx
 * <BranchListItem
 *   branch={{ id: '1', name: 'feature/test', repositoryName: 'MyRepo', status: 'idle', hasUnread: false }}
 *   isSelected={false}
 *   onClick={() => selectBranch('1')}
 * />
 * ```
 */
export const BranchListItem = memo(function BranchListItem({
  branch,
  isSelected,
  onClick,
}: BranchListItemProps) {
  return (
    <button
      data-testid="branch-list-item"
      onClick={onClick}
      aria-current={isSelected ? 'true' : undefined}
      className={`
        w-full px-4 py-3 flex flex-col gap-1
        hover:bg-gray-800 transition-colors
        focus:outline-none focus:ring-2 focus:ring-inset focus:ring-blue-500
        ${isSelected ? 'bg-gray-700 border-l-2 border-blue-500' : 'border-l-2 border-transparent'}
      `}
    >
      {/* Main row: CLI status dots, info, unread */}
      <div className="flex items-center gap-3 w-full">
        {/* CLI tool status dots */}
        {branch.cliStatus && (
          <div className="flex items-center gap-1 flex-shrink-0" aria-label="CLI tool status">
            <CliStatusDot status={branch.cliStatus.claude} label="Claude" />
            <CliStatusDot status={branch.cliStatus.codex} label="Codex" />
          </div>
        )}

        {/* Branch info */}
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-white truncate">
            {branch.name}
          </p>
          <p className="text-xs text-gray-400 truncate">
            {branch.repositoryName}
          </p>
        </div>

        {/* Unread indicator */}
        {branch.hasUnread && (
          <span
            data-testid="unread-indicator"
            className="w-2 h-2 rounded-full bg-blue-500 flex-shrink-0"
            aria-label="Has unread messages"
          />
        )}
      </div>

      {/* Description display (shown for all branches with description) */}
      {branch.description && (
        <div
          data-testid="branch-description"
          className="pl-6 pr-2 mt-1 text-left"
        >
          <p className="text-xs text-gray-400 line-clamp-2">
            {branch.description}
          </p>
        </div>
      )}
    </button>
  );
});
