/**
 * BranchListItem Component
 *
 * Individual branch item in the sidebar list.
 * Shows branch name, repository, status, and unread indicator.
 */

'use client';

import React, { memo, useRef, useState, useEffect, useCallback } from 'react';
import ReactDOM from 'react-dom';
import { useTranslations } from 'next-intl';
import type { SidebarBranchItem } from '@/types/sidebar';
import { aggregateCliStatus, formatCliStatusBreakdown } from '@/types/sidebar';
import { BranchStatusIndicator } from '@/components/sidebar/BranchStatusIndicator';

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
        bg-sidebar text-xs text-sidebar-foreground border border-sidebar-border
        pointer-events-none max-w-sm
        transition-opacity duration-150
      "
      style={{
        top: coords.top,
        left: coords.left,
      }}
    >
      <p className="font-medium text-sidebar-foreground whitespace-nowrap">{branch.name}</p>
      <p className="text-sidebar-muted whitespace-nowrap">{branch.repositoryName}</p>
      <p className="text-sidebar-muted whitespace-nowrap">Status: {branch.status}</p>
      {branch.worktreePath && (
        <p className="text-sidebar-muted truncate">{branch.worktreePath}</p>
      )}
      {branch.description && (
        <p className="text-sidebar-muted mt-1 border-t border-sidebar-border pt-1 whitespace-pre-wrap break-words">
          {branch.description}
        </p>
      )}
    </div>,
    document.body
  );
}

// ============================================================================
// Module-level tooltip suppression
// ============================================================================

/**
 * Timestamp (ms) until which onMouseEnter should NOT open a tooltip.
 * Set by handleClick so that list reorders caused by React re-renders
 * after a branch click don't immediately show a tooltip on whichever
 * element lands under the cursor.
 */
let suppressMouseEnterUntil = 0;

/** Exported only for tests — reset click-triggered tooltip suppression. */
export function __resetMouseEnterSuppression(): void {
  suppressMouseEnterUntil = 0;
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
  const t = useTranslations('common');
  const tooltipId = `tooltip-${branch.id}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [isTooltipVisible, setIsTooltipVisible] = useState(false);
  // Timer for the 150ms show-delay (prevents spurious tooltips from
  // DOM-reflow mouseenter events triggered by polling list reorders).
  const showTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearShowTimer = useCallback(() => {
    if (showTimerRef.current !== null) {
      clearTimeout(showTimerRef.current);
      showTimerRef.current = null;
    }
  }, []);

  // Cancel the pending timer when the component unmounts.
  useEffect(() => () => clearShowTimer(), [clearShowTimer]);

  // Issue #676 (A): selected branches never show the tooltip so a stuck
  // `isTooltipVisible=true` does not leave a tooltip lingering next to the
  // currently-focused item.
  const showTooltip = isTooltipVisible && !isSelected;

  // Safety net A: reset tooltip whenever isSelected becomes true.
  useEffect(() => {
    if (isSelected) {
      setIsTooltipVisible(false);
    }
  }, [isSelected]);

  // Safety net B: close this tooltip on ANY document click.
  // This handles the case where onMouseLeave doesn't fire (fast cursor moves,
  // DOM changes from polling during click, React concurrent re-renders) and
  // another branch's tooltip stays visible showing wrong-repository content.
  useEffect(() => {
    if (!isTooltipVisible) return;
    const close = () => setIsTooltipVisible(false);
    document.addEventListener('click', close);
    return () => document.removeEventListener('click', close);
  }, [isTooltipVisible]);

  // Issue #676 (B): clicking closes the tooltip explicitly before firing the
  // upstream onClick, so even if a subsequent re-render misses the mouseleave
  // event, the tooltip state is reset.
  const handleClick = () => {
    clearShowTimer();
    // Suppress mouseenter-triggered tooltips for 400ms so that list reorders
    // caused by the re-render following this click don't immediately show a
    // tooltip on whichever element lands under the cursor.
    suppressMouseEnterUntil = Date.now() + 400;
    setIsTooltipVisible(false);
    onClick();
  };

  return (
    <button
      ref={buttonRef}
      data-testid="branch-list-item"
      onClick={handleClick}
      onMouseEnter={() => {
        clearShowTimer();
        if (Date.now() >= suppressMouseEnterUntil) {
          // 150ms delay: filters out spurious mouseenter events fired when the
          // browser moves a DOM element under the stationary cursor (polling
          // list reorders). An intentional hover outlasts this delay easily.
          showTimerRef.current = setTimeout(() => {
            setIsTooltipVisible(true);
          }, 150);
        }
      }}
      onMouseLeave={() => {
        clearShowTimer();
        setIsTooltipVisible(false);
      }}
      onFocus={(e) => {
        clearShowTimer();
        // Show tooltip only for keyboard focus (:focus-visible), not pointer clicks.
        // onFocus fires on mousedown which races with handleClick, causing a
        // brief tooltip flash even after the click handler closes it.
        if ((e.target as HTMLElement).matches(':focus-visible')) {
          showTimerRef.current = setTimeout(() => {
            setIsTooltipVisible(true);
          }, 150);
        }
      }}
      onBlur={() => {
        clearShowTimer();
        setIsTooltipVisible(false);
      }}
      aria-current={isSelected ? 'true' : undefined}
      aria-describedby={showTooltip ? tooltipId : undefined}
      aria-label={!showRepositoryName ? `${branch.name} - ${branch.repositoryName}` : undefined}
      className={`
        group relative w-full px-4 py-3 flex flex-col gap-1
        hover:bg-sidebar-hover transition-colors
        focus:outline-none focus:ring-2 focus:ring-inset focus:ring-ring
        ${isSelected ? 'bg-sidebar-hover border-l-2 border-accent-500' : 'border-l-2 border-transparent'}
      `}
    >
      {/* Main row: aggregated CLI status, info, unread */}
      <div className="flex items-center gap-3 w-full">
        {/*
          Aggregated CLI tool status (Issue #867): a single icon replaces the
          per-agent dots. The most significant status is shown; hover/focus
          reveals the per-agent breakdown via the indicator's title/aria-label.
        */}
        {branch.cliStatus && Object.keys(branch.cliStatus).length > 0 && (
          <div className="flex items-center justify-center flex-shrink-0 w-4" aria-label={t('branchItem.cliToolStatus')}>
            <BranchStatusIndicator
              status={aggregateCliStatus(branch.cliStatus)}
              label={formatCliStatusBreakdown(branch.cliStatus, branch.cliStatusLabels)}
            />
          </div>
        )}

        {/* Branch info */}
        <div className="flex-1 min-w-0 text-left">
          <p className="text-sm font-medium text-sidebar-foreground truncate">
            {branch.name}
          </p>
          {showRepositoryName && (
            <p className="text-xs text-sidebar-muted truncate">
              {branch.repositoryName}
            </p>
          )}
        </div>

        {/* Unread indicator */}
        {branch.hasUnread && (
          <span
            data-testid="unread-indicator"
            className="w-2 h-2 rounded-full bg-accent-500 flex-shrink-0"
            aria-label={t('branchItem.hasUnread')}
          />
        )}
      </div>

      {/* Description display (shown for all branches with description) */}
      {branch.description && (
        <div
          data-testid="branch-description"
          className="pl-6 pr-2 mt-1 text-left"
        >
          <p className="text-xs text-sidebar-muted line-clamp-2">
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
