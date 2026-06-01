/**
 * TerminalContainer Component (Issue #730, updated Issue #744)
 *
 * Inner layout wrapper around the Terminal + FilePanel area.
 *
 * Issue #744: the History pane was moved INSIDE each PC terminal split
 * (`TerminalSplitPaneContent`) so each split shows only its own cliToolId's
 * messages. The top-level History column is therefore no longer rendered on PC:
 * the parent stops passing the `history` prop and TerminalContainer renders the
 * terminal area only. The `history` prop is kept (optional) for backward
 * compatibility — when provided, the legacy History column + resizer + expand
 * bar render exactly as before (Issue #730 behavior).
 *
 * Responsibilities (when `history` is provided):
 *   - Read History pane visibility / width from `useHistoryPaneState`.
 *   - When visible, render History (with `id={HISTORY_PANE_ID}`) + PaneResizer.
 *   - When collapsed, render a compact expand bar with `aria-controls`
 *     pointing at the same `id`.
 *   - Always render the terminal area on the right (flex-grow).
 *   - Wrap each side in its own ErrorBoundary for fault isolation.
 */

'use client';

import React, { memo, useCallback, useRef, type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { useHistoryPaneState } from '@/hooks/useHistoryPaneState';
import { PaneResizer } from './PaneResizer';

/**
 * Public id used by:
 *  - HistoryPane internal collapse button → `aria-controls`
 *  - TerminalContainer collapsed expand bar → `aria-controls`
 *
 * Both references must stay in sync so screen readers can announce the same
 * region when toggling.
 */
export const HISTORY_PANE_ID = 'worktree-history-pane';

const EXPAND_BAR_WIDTH_PX = 24;

export interface TerminalContainerProps {
  /**
   * History pane content. Rendered only when provided AND `visible=true`.
   *
   * Issue #744: omitted on PC (History moved into each terminal split). Kept
   * optional for backward compatibility with the Issue #730 single-column
   * History layout.
   */
  history?: ReactNode;
  /** Terminal + FilePanel content. Always rendered. */
  terminal: ReactNode;
}

const HistoryExpandBar = memo(function HistoryExpandBar({
  onToggle,
}: {
  onToggle: () => void;
}) {
  return (
    <div
      data-testid="terminal-container-expand-bar"
      style={{ width: `${EXPAND_BAR_WIDTH_PX}px` }}
      className="flex-shrink-0 flex items-center justify-center bg-gray-100 dark:bg-gray-800 border-r border-gray-200 dark:border-gray-700"
    >
      <button
        type="button"
        data-testid="history-pane-expand"
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
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={2}
            d="M9 5l7 7-7 7"
          />
        </svg>
      </button>
    </div>
  );
});

/**
 * Layout wrapper that combines History pane + Terminal / FilePanel into a
 * single flex container. Used as the `rightPane` of `WorktreeDesktopLayout`.
 */
export const TerminalContainer = memo(function TerminalContainer({
  history,
  terminal,
}: TerminalContainerProps) {
  const { visible, width, toggle, setWidth } = useHistoryPaneState();
  const containerRef = useRef<HTMLDivElement>(null);

  const handleResize = useCallback(
    (deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const percentDelta = (deltaPx / w) * 100;
      setWidth(width + percentDelta);
    },
    [width, setWidth]
  );

  // Issue #744: when no history is supplied (PC default), render the terminal
  // area only — the History pane lives inside each terminal split.
  const hasHistory = history !== undefined && history !== null;

  return (
    <div ref={containerRef} className="flex h-full min-h-0 w-full">
      {hasHistory &&
        (visible ? (
          <>
            <div
              id={HISTORY_PANE_ID}
              data-testid="terminal-container-history-slot"
              aria-label="History pane"
              style={{ width: `${width}%` }}
              className="flex-shrink-0 overflow-hidden transition-[width] duration-200 ease-in-out"
            >
              <ErrorBoundary componentName="HistoryPane">{history}</ErrorBoundary>
            </div>
            <PaneResizer
              onResize={handleResize}
              orientation="horizontal"
              ariaValueNow={width}
            />
          </>
        ) : (
          <HistoryExpandBar onToggle={toggle} />
        ))}
      <div
        data-testid="terminal-container-terminal-slot"
        aria-label="Terminal pane"
        className="flex-grow overflow-hidden min-w-0"
      >
        <ErrorBoundary componentName="TerminalAndFilePanel">
          {terminal}
        </ErrorBoundary>
      </div>
    </div>
  );
});

export default TerminalContainer;
