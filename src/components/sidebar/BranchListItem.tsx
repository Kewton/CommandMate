/**
 * BranchListItem Component
 *
 * Individual branch item in the sidebar list.
 * Shows branch name, repository, status, and unread indicator.
 */

'use client';

import React, { memo } from 'react';
import type { SidebarBranchItem } from '@/types/sidebar';
import { BranchStatusIndicator } from './BranchStatusIndicator';

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
      {/* Main row: status, info, unread */}
      <div className="flex items-center gap-3 w-full">
        {/* Status indicator */}
        <BranchStatusIndicator status={branch.status} />

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

      {/* Memo display (only when selected and memo exists) */}
      {isSelected && branch.memo && (
        <div
          data-testid="branch-memo"
          className="pl-6 pr-2 mt-1 text-left"
        >
          <p className="text-xs text-gray-400 line-clamp-2">
            {branch.memo}
          </p>
        </div>
      )}
    </button>
  );
});
