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
 * compatibility — when provided, the legacy History column + resizer render as
 * before (Issue #730 behavior).
 *
 * Issue #2259 removed the collapsed expand bar. It was the same 36px vertical
 * strip the splits carried, offering a second place to reopen a column the
 * Action-bar toggle already owns, and — since #744 stopped passing `history` —
 * it had no production caller left at all. Hiding the column now simply gives
 * the whole row to the terminal.
 *
 * Responsibilities (when `history` is provided):
 *   - Read History pane visibility / width from `useHistoryPaneState`.
 *   - When visible, render History (with `id={HISTORY_PANE_ID}`) + PaneResizer.
 *   - When hidden, render nothing on the left.
 *   - Always render the terminal area on the right (flex-grow).
 *   - Wrap each side in its own ErrorBoundary for fault isolation.
 */

'use client';

import React, { memo, useCallback, useRef, type ReactNode } from 'react';
import { ErrorBoundary } from '@/components/error/ErrorBoundary';
import { useHistoryPaneState } from '@/hooks/useHistoryPaneState';
import { PaneResizer } from './PaneResizer';

/**
 * Public id of the legacy single-column History region, named by the
 * `HistoryPane` collapse button's `aria-controls` when the pane is rendered
 * outside a split (mobile / the Issue #730 layout).
 */
export const HISTORY_PANE_ID = 'worktree-history-pane';

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

/**
 * Layout wrapper that combines History pane + Terminal / FilePanel into a
 * single flex container. Used as the `rightPane` of `WorktreeDesktopLayout`.
 */
export const TerminalContainer = memo(function TerminalContainer({
  history,
  terminal,
}: TerminalContainerProps) {
  const { visible, width, setWidth } = useHistoryPaneState();
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
        ) : null)}
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
