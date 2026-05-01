/**
 * BranchListItem Component
 *
 * Individual branch item in the sidebar list.
 * Shows branch name, repository, status, and unread indicator.
 */

'use client';

import React, { memo, useRef, useState, useEffect } from 'react';
import ReactDOM from 'react-dom';
import type { SidebarBranchItem, BranchStatus } from '@/types/sidebar';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';

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
  /** Whether to show the repository name inline (Issue #651: hidden in grouped view) */
  showRepositoryName?: boolean;
}

// ============================================================================
// Sub-components
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

/**
 * Tooltip shown on hover/focus with branch details (Issue #651, #676).
 * Rendered via React portal to escape the sidebar's overflow-y:auto clipping.
 * Only mounted into the DOM while `isVisible` is true (Issue #676 fix) to avoid
 * stuck-tooltip states caused by missed `mouseleave`/`blur` events.
 */
function BranchTooltip({
  id,
  branch,
  isVisible,
  anchorRef,
}: {
  id: string;
  branch: SidebarBranchItem;
  isVisible: boolean;
  anchorRef: { current: HTMLButtonElement | null };
}) {
  // Start off-screen so tooltip is never briefly visible at (0,0) before coords are set
  const [coords, setCoords] = useState({ top: -9999, left: -9999 });

  // Update position when tooltip becomes visible
  // (Hook ordering kept intact: this effect runs unconditionally on every render.)
  useEffect(() => {
    if (isVisible && anchorRef.current) {
      const rect = anchorRef.current.getBoundingClientRect();
      setCoords({ top: rect.top, left: rect.right + 8 });
    }
  }, [isVisible, anchorRef]);

  // Portals require document — skip during SSR
  // (portal content is outside the component subtree so there is no hydration mismatch)
  if (typeof document === 'undefined') return null;

  // Issue #676: Unmount tooltip content when not visible so a stale
  // `isTooltipVisible=true` can never cause the tooltip to linger in the DOM.
  if (!isVisible) return null;

  return ReactDOM.createPortal(
    <div
      id={id}
      role="tooltip"
      className="
        fixed z-[9999]
        px-3 py-2 rounded-md shadow-lg
        bg-gray-950 text-xs text-gray-200 border border-gray-700
        pointer-events-none max-w-sm
        transition-opacity duration-150
      "
      style={{
        top: coords.top,
        left: coords.left,
      }}
    >
      <p className="font-medium text-white whitespace-nowrap">{branch.name}</p>
      <p className="text-gray-400 whitespace-nowrap">{branch.repositoryName}</p>
      <p className="text-gray-400 whitespace-nowrap">Status: {branch.status}</p>
      {branch.worktreePath && (
        <p className="text-gray-500 truncate">{branch.worktreePath}</p>
      )}
      {branch.description && (
        <p className="text-gray-300 mt-1 border-t border-gray-700 pt-1 whitespace-pre-wrap break-words">
          {branch.description}
        </p>
      )}
    </div>,
    document.body
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
  showRepositoryName = true,
}: BranchListItemProps) {
  const tooltipId = `tooltip-${branch.id}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);

  // Issue #676 (A): selected branches never show the tooltip so a stuck
  // `isTooltipVisible=true` does not leave a tooltip lingering next to the
  // currently-focused item.
  const showTooltip = isTooltipVisible && !isSelected;

  // Safety net: reset tooltip whenever isSelected becomes true.
  // Covers React concurrent-mode timing gaps (router.push inside startTransition
  // defers the sidebar re-render), onFocus/onClick inter-batch races, and
  // group-expansion onMouseEnter triggers that fire before the selection lands.
  useEffect(() => {
    if (isSelected) {
      setIsTooltipVisible(false);
    }
  }, [isSelected]);

  // Issue #676 (B): clicking closes the tooltip explicitly before firing the
  // upstream onClick, so even if a subsequent re-render misses the mouseleave
  // event, the tooltip state is reset.
  const handleClick = () => {
    setIsTooltipVisible(false);
    onClick();
  };

  return (
    <button
      ref={buttonRef}
      data-testid="branch-list-item"
      onClick={handleClick}
      onMouseEnter={() => setIsTooltipVisible(true)}
      onMouseLeave={() => setIsTooltipVisible(false)}
      onFocus={() => setIsTooltipVisible(true)}
      onBlur={() => setIsTooltipVisible(false)}
      aria-current={isSelected ? 'true' : undefined}
      aria-describedby={showTooltip ? tooltipId : undefined}
      aria-label={!showRepositoryName ? `${branch.name} - ${branch.repositoryName}` : undefined}
      className={`
        group relative w-full px-4 py-3 flex flex-col gap-1
        hover:bg-gray-700 transition-colors
        focus:outline-none focus:ring-2 focus:ring-inset focus:ring-cyan-500
        ${isSelected ? 'bg-gray-600 border-l-2 border-cyan-500' : 'border-l-2 border-transparent'}
      `}
    >
      {/* Main row: CLI status dots, info, unread */}
      <div className="flex items-center gap-3 w-full">
        {/* CLI tool status dots (Issue #368: dynamic from selectedAgents) */}
        {branch.cliStatus && Object.keys(branch.cliStatus).length > 0 && (
          <div className="flex items-center gap-1 flex-shrink-0 w-11" aria-label="CLI tool status">
            {Object.entries(branch.cliStatus).map(([tool, status]) => (
              <CliStatusDot
                key={tool}
                status={status ?? 'idle'}
                label={getCliToolDisplayName(tool as CLIToolType)}
              />
            ))}
          </div>
        )}

        {/* Branch info */}
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-white truncate">
            {branch.name}
          </p>
          {showRepositoryName && (
            <p className="text-xs text-gray-400 truncate">
              {branch.repositoryName}
            </p>
          )}
        </div>

        {/* Unread indicator */}
        {branch.hasUnread && (
          <span
            data-testid="unread-indicator"
            className="w-2 h-2 rounded-full bg-cyan-500 flex-shrink-0"
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

      {/* Tooltip: portal to document.body to escape overflow clipping (Issue #651) */}
      <BranchTooltip
        id={tooltipId}
        branch={branch}
        isVisible={showTooltip}
        anchorRef={buttonRef}
      />
    </button>
  );
});
