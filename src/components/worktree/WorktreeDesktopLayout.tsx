/**
 * WorktreeDesktopLayout Component (Issue #727)
 *
 * 4-column desktop layout:
 *   [ActivityBar 48px] + Resizer + [ActivityPane (variable, optional)]
 *   + Resizer + [HistoryPane (variable, optional)] + Resizer + [Right (flex)]
 *
 * - When `activityPane` is null, the activity column AND its trailing resizer
 *   are hidden.
 * - When `historyPaneCollapsed` is true, the history column AND its
 *   trailing/leading resizer are hidden, and a 24px expand bar with a ◀
 *   button is shown to re-open it.
 * - Mobile (`useIsMobile === true`): falls back to a 2-pane swipe layout to
 *   preserve the previous behavior. The "left" side composes the history
 *   pane if visible, otherwise the activity pane.
 *
 * Each pane is wrapped in ErrorBoundary for fault isolation.
 */

'use client';

import React, { useState, useCallback, useRef, useMemo, memo, ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { useIsMobile } from '@/hooks/useIsMobile';
import { PaneResizer } from './PaneResizer';

// ============================================================================
// Types
// ============================================================================

/**
 * Props for WorktreeDesktopLayout component (Issue #727 4-column API).
 */
export interface WorktreeDesktopLayoutProps {
  /** Vertical 48px Activity Bar element (always rendered on PC). */
  activityBar: ReactNode;
  /** Activity Pane content. Pass `null` to hide the column entirely. */
  activityPane: ReactNode | null;
  /** History Pane content. Pass `null` (or set `historyPaneCollapsed`) to hide. */
  historyPane: ReactNode | null;
  /** Right column (terminal + file panel). Always rendered. */
  rightPane: ReactNode;

  /** Width of the activity pane column in percent (default 18). */
  activityPaneWidth?: number;
  /** Width of the history pane column in percent (default 22). */
  historyPaneWidth?: number;
  /** Minimum pane width in percent (default 10). */
  minPaneWidth?: number;
  /** Maximum pane width in percent (default 60). */
  maxPaneWidth?: number;

  /** Called when the activity pane is resized (delta in percent). */
  onActivityPaneResize?: (nextPercent: number) => void;
  /** Called when the history pane is resized (delta in percent). */
  onHistoryPaneResize?: (nextPercent: number) => void;

  /** History pane collapsed flag (when true, history column is hidden + expand bar shown). */
  historyPaneCollapsed?: boolean;
  /** Toggle the history pane (called by the expand bar). */
  onToggleHistoryPane?: () => void;

  /** Optional extra className for the root element. */
  className?: string;
}

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_ACTIVITY_PANE_WIDTH = 18;
const DEFAULT_HISTORY_PANE_WIDTH = 22;
const DEFAULT_MIN_PANE_WIDTH = 10;
const DEFAULT_MAX_PANE_WIDTH = 60;

const EXPAND_BAR_WIDTH_PX = 24;

const ACTIVITY_BAR_ID = 'worktree-activity-bar';
const ACTIVITY_PANE_ID = 'worktree-activity-pane';
const HISTORY_PANE_ID = 'worktree-history-pane';
const RIGHT_PANE_ID = 'worktree-right-pane';

// ============================================================================
// Mobile fallback
// ============================================================================

type ActivePane = 'left' | 'right';

const MobileLayout = memo(function MobileLayout({
  leftPane,
  rightPane,
}: {
  leftPane: ReactNode;
  rightPane: ReactNode;
}) {
  const [activePane, setActivePane] = useState<ActivePane>('right');

  const handleLeftClick = useCallback(() => setActivePane('left'), []);
  const handleRightClick = useCallback(() => setActivePane('right'), []);

  const currentPane = activePane === 'left' ? leftPane : rightPane;

  return (
    <div data-testid="mobile-layout" className="flex flex-col h-full">
      <div className="flex border-b border-gray-700 bg-gray-800" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={activePane === 'left'}
          aria-controls="left-panel"
          onClick={handleLeftClick}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
            activePane === 'left'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-900'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          History
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activePane === 'right'}
          aria-controls="right-panel"
          onClick={handleRightClick}
          className={`flex-1 py-2 px-4 text-sm font-medium transition-colors ${
            activePane === 'right'
              ? 'text-blue-400 border-b-2 border-blue-400 bg-gray-900'
              : 'text-gray-400 hover:text-gray-300'
          }`}
        >
          Terminal
        </button>
      </div>
      <div
        id={`${activePane}-panel`}
        role="tabpanel"
        className="flex-1 overflow-hidden"
      >
        <ErrorBoundary
          componentName={activePane === 'left' ? 'HistoryPane' : 'TerminalPane'}
        >
          {currentPane}
        </ErrorBoundary>
      </div>
    </div>
  );
});

// ============================================================================
// ResizableColumn — DRY helper for the activity / history columns.
// Both columns share the same wrapper structure (id + data-testid + aria-label
// + width style + transition class + ErrorBoundary) followed by a resizer.
// Extracting this avoids drift between the two blocks when DOM contracts are
// updated. The DOM contract (id, data-testid, aria-label, style.width) is
// covered by WorktreeDesktopLayout.test.tsx.
// ============================================================================

interface ResizableColumnProps {
  /** DOM id used for aria-controls wiring (e.g. `worktree-history-pane`). */
  id: string;
  /** data-testid for the column slot wrapper (e.g. `history-pane-slot`). */
  slotTestId: string;
  /** aria-label for the column slot wrapper. */
  ariaLabel: string;
  /** Width in percent (rendered as `${width}%`). */
  widthPercent: number;
  /** ErrorBoundary componentName for fault isolation. */
  errorBoundaryName: string;
  /** Resizer callback (delta in pixels). */
  onResize: (delta: number) => void;
  /** Column content. */
  children: ReactNode;
}

const ResizableColumn = memo(function ResizableColumn({
  id,
  slotTestId,
  ariaLabel,
  widthPercent,
  errorBoundaryName,
  onResize,
  children,
}: ResizableColumnProps) {
  return (
    <>
      <div
        id={id}
        data-testid={slotTestId}
        aria-label={ariaLabel}
        style={{ width: `${widthPercent}%` }}
        className="flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out"
      >
        <ErrorBoundary componentName={errorBoundaryName}>{children}</ErrorBoundary>
      </div>
      <PaneResizer
        onResize={onResize}
        orientation="horizontal"
        ariaValueNow={widthPercent}
      />
    </>
  );
});

// ============================================================================
// Expand bar (history)
// ============================================================================

const HistoryExpandBar = memo(function HistoryExpandBar({
  onToggle,
}: {
  onToggle?: () => void;
}) {
  return (
    <div
      data-testid="history-expand-bar"
      style={{ width: `${EXPAND_BAR_WIDTH_PX}px` }}
      className="flex-shrink-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 border-l border-r border-gray-200 dark:border-gray-700"
    >
      <button
        type="button"
        aria-label="Expand history panel"
        aria-expanded="false"
        aria-controls={HISTORY_PANE_ID}
        onClick={onToggle}
        className="flex items-center justify-center w-full h-10 text-gray-500 dark:text-gray-400 hover:text-cyan-600 dark:hover:text-cyan-400 focus:outline-none focus:ring-2 focus:ring-cyan-500"
      >
        <svg
          className="w-4 h-4"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
          aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
      </button>
    </div>
  );
});

// ============================================================================
// Main component
// ============================================================================

export const WorktreeDesktopLayout = memo(function WorktreeDesktopLayout({
  activityBar,
  activityPane,
  historyPane,
  rightPane,
  activityPaneWidth = DEFAULT_ACTIVITY_PANE_WIDTH,
  historyPaneWidth = DEFAULT_HISTORY_PANE_WIDTH,
  minPaneWidth = DEFAULT_MIN_PANE_WIDTH,
  maxPaneWidth = DEFAULT_MAX_PANE_WIDTH,
  onActivityPaneResize,
  onHistoryPaneResize,
  historyPaneCollapsed = false,
  onToggleHistoryPane,
  className = '',
}: WorktreeDesktopLayoutProps) {
  const isMobile = useIsMobile();
  const containerRef = useRef<HTMLDivElement>(null);

  // Internal width state (controlled fallback when no on*Resize callback is provided).
  const [localActivityWidth, setLocalActivityWidth] = useState(activityPaneWidth);
  const [localHistoryWidth, setLocalHistoryWidth] = useState(historyPaneWidth);

  // Effective widths follow props if they look "controlled", otherwise the
  // internal state. We update internal state when the user drags.
  const effectiveActivityWidth = onActivityPaneResize ? activityPaneWidth : localActivityWidth;
  const effectiveHistoryWidth = onHistoryPaneResize ? historyPaneWidth : localHistoryWidth;

  const handleActivityResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const percentDelta = (delta / w) * 100;
      const current = onActivityPaneResize ? activityPaneWidth : localActivityWidth;
      const next = Math.min(maxPaneWidth, Math.max(minPaneWidth, current + percentDelta));
      if (onActivityPaneResize) onActivityPaneResize(next);
      else setLocalActivityWidth(next);
    },
    [activityPaneWidth, localActivityWidth, minPaneWidth, maxPaneWidth, onActivityPaneResize]
  );

  const handleHistoryResize = useCallback(
    (delta: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const percentDelta = (delta / w) * 100;
      const current = onHistoryPaneResize ? historyPaneWidth : localHistoryWidth;
      const next = Math.min(maxPaneWidth, Math.max(minPaneWidth, current + percentDelta));
      if (onHistoryPaneResize) onHistoryPaneResize(next);
      else setLocalHistoryWidth(next);
    },
    [historyPaneWidth, localHistoryWidth, minPaneWidth, maxPaneWidth, onHistoryPaneResize]
  );

  const containerClassName = useMemo(
    () => `flex h-full min-h-0 ${className}`.trim(),
    [className]
  );

  // Mobile fallback: collapse to old 2-pane swipe. Compose left side from
  // whichever pane is currently "visible" (history wins if open, else activity).
  if (isMobile) {
    const leftForMobile = !historyPaneCollapsed && historyPane ? historyPane : activityPane;
    return <MobileLayout leftPane={leftForMobile ?? null} rightPane={rightPane} />;
  }

  const showActivityCol = activityPane !== null;
  const showHistoryCol = historyPane !== null && !historyPaneCollapsed;

  return (
    <div ref={containerRef} className="h-full">
      <div
        data-testid="desktop-layout"
        role="main"
        className={containerClassName}
      >
        {/* Activity Bar (48px fixed) */}
        <div
          id={ACTIVITY_BAR_ID}
          data-testid="activity-bar-slot"
          className="flex-shrink-0"
        >
          <ErrorBoundary componentName="ActivityBar">{activityBar}</ErrorBoundary>
        </div>

        {/* Activity Pane (variable, optional) */}
        {showActivityCol && (
          <ResizableColumn
            id={ACTIVITY_PANE_ID}
            slotTestId="activity-pane-slot"
            ariaLabel="Activity pane"
            widthPercent={effectiveActivityWidth}
            errorBoundaryName="ActivityPane"
            onResize={handleActivityResize}
          >
            {activityPane}
          </ResizableColumn>
        )}

        {/* History Pane (variable, optional) */}
        {showHistoryCol ? (
          <ResizableColumn
            id={HISTORY_PANE_ID}
            slotTestId="history-pane-slot"
            ariaLabel="History pane"
            widthPercent={effectiveHistoryWidth}
            errorBoundaryName="HistoryPane"
            onResize={handleHistoryResize}
          >
            {historyPane}
          </ResizableColumn>
        ) : (
          historyPaneCollapsed && <HistoryExpandBar onToggle={onToggleHistoryPane} />
        )}

        {/* Right pane (terminal + file panel) — fills remaining space */}
        <div
          id={RIGHT_PANE_ID}
          data-testid="right-pane-slot"
          aria-label="Terminal pane"
          className="flex-grow overflow-hidden min-w-0"
        >
          <ErrorBoundary componentName="TerminalPane">{rightPane}</ErrorBoundary>
        </div>
      </div>
    </div>
  );
});

export default WorktreeDesktopLayout;
