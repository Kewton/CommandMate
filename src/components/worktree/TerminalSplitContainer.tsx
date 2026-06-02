/**
 * TerminalSplitContainer Component (Issue #728)
 *
 * Hosts 1-3 horizontal terminal splits in the PC layout. Owns:
 *  - split configuration via `useTerminalSplits` (worktreeId-scoped)
 *  - add / remove buttons (disabled at the MIN / MAX boundary and while
 *    a PaneResizer drag is in progress)
 *  - PaneResizer widget(s) between splits, with width persistence
 *  - delegating each split's body to a parent-supplied `renderPane`
 *
 * Does NOT include HistoryPane (HISTORY_PANE_ID uniqueness is owned by
 * TerminalContainer per Issue #730).
 *
 * a11y: outer container `role="group" aria-label="Terminal splits"`. Each
 * pane itself owns `role="region"` inside TerminalSplitPane.
 */

'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { getCliToolDisplayName, type CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import { MAX_SPLITS, MIN_SPLITS } from '@/config/terminal-split-config';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import { PaneResizer } from './PaneResizer';

/** Render-prop signature: each pane is supplied externally so the
 *  container does not need to know about MessageInput / TerminalDisplay. */
export interface RenderTerminalSplitPaneArgs {
  splitIndex: number;
  cliToolId: CLIToolType;
  availableCliTools: CLIToolType[];
  onCliToolChange: (cliId: CLIToolType) => void;
  onFocus: () => void;
  isFocused: boolean;
  /**
   * Issue #786: handle a CLI tool dropped onto this split. The container owns
   * the no-op / reject / apply classification (it holds the `splits` array), so
   * the pane just forwards the dropped cliId here. Stable per-index reference.
   */
  onDropCliTool: (cliId: CLIToolType) => void;
}

export interface TerminalSplitContainerProps {
  worktreeId: string;
  /** Render a single split body. Caller wires sendMessage / TerminalDisplay. */
  renderPane: (args: RenderTerminalSplitPaneArgs) => ReactNode;
  /**
   * Optional callback fired when `focusedSplitIndex` changes — used by the
   * parent to route HistoryPane / MemoPane insertion targets.
   */
  onFocusedSplitChange?: (idx: number) => void;
  /**
   * Issue #786 (S1-004 / D-5): toast callback for drag-drop feedback. Optional
   * for backward compat — when omitted, drop still applies but no toast shows.
   */
  showToast?: ShowToast;
  /**
   * Issue #786 (S1-005): called with the new cliId after a successful drop so
   * the parent can sync the (worktree-global) activeCliTab to the drop target
   * split's new CLI. Fires only when the change is actually applied.
   */
  onActiveCliTabChange?: (cliId: CLIToolType) => void;
}

export const TerminalSplitContainer = memo(function TerminalSplitContainer({
  worktreeId,
  renderPane,
  onFocusedSplitChange,
  showToast,
  onActiveCliTabChange,
}: TerminalSplitContainerProps) {
  const {
    splits,
    widths,
    addSplit,
    removeSplit,
    setSplitCliTool,
    setSplitWidth,
    availableCliTools,
    focusedSplitIndex,
    setFocusedSplitIndex,
  } = useTerminalSplits(worktreeId);

  const containerRef = useRef<HTMLDivElement>(null);
  const [isResizing, setIsResizing] = useState(false);

  // Track which splitIndex was last added so we can move focus into its pane.
  const prevSplitCountRef = useRef(splits.length);
  const [lastAddedIndex, setLastAddedIndex] = useState<number | null>(null);
  useEffect(() => {
    if (splits.length > prevSplitCountRef.current) {
      setLastAddedIndex(splits.length - 1);
    }
    prevSplitCountRef.current = splits.length;
  }, [splits.length]);

  // Notify parent when focus changes (HistoryPane / MemoPane insertion target).
  useEffect(() => {
    onFocusedSplitChange?.(focusedSplitIndex);
  }, [focusedSplitIndex, onFocusedSplitChange]);

  // After lastAddedIndex changes, focus the textarea in that pane.
  useEffect(() => {
    if (lastAddedIndex === null) return;
    const container = containerRef.current;
    if (!container) return;
    const pane = container.querySelector<HTMLElement>(
      `[data-split-index="${lastAddedIndex}"]`,
    );
    if (!pane) return;
    const textarea = pane.querySelector<HTMLTextAreaElement>('textarea');
    textarea?.focus();
    // Update focusedSplitIndex too.
    setFocusedSplitIndex(lastAddedIndex);
    setLastAddedIndex(null);
  }, [lastAddedIndex, setFocusedSplitIndex]);

  const handleResize = useCallback(
    (resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const sum = widths.reduce((s, x) => s + x, 0);
      const percentDelta = (deltaPx / w) * sum;
      const next = [...widths];
      const left = next[resizerIdx] + percentDelta;
      const right = next[resizerIdx + 1] - percentDelta;
      // Don't shrink either side past a tiny floor.
      const FLOOR = sum * 0.05;
      if (left < FLOOR || right < FLOOR) return;
      next[resizerIdx] = left;
      next[resizerIdx + 1] = right;
      setSplitWidth(next);
    },
    [widths, setSplitWidth],
  );

  const handleResizeStart = useCallback(() => setIsResizing(true), []);
  const handleResizeEnd = useCallback(() => setIsResizing(false), []);

  const canAdd = splits.length < MAX_SPLITS && !isResizing;
  const canRemove = splits.length > MIN_SPLITS && !isResizing;

  // Memoize per-split onFocus handlers so prop identity is stable.
  const focusHandlers = useMemo(
    () => splits.map((_, idx) => () => setFocusedSplitIndex(idx)),
    [splits, setFocusedSplitIndex],
  );

  const cliChangeHandlers = useMemo(
    () =>
      splits.map((_, idx) => (cliId: CLIToolType) => setSplitCliTool(idx, cliId)),
    [splits, setSplitCliTool],
  );

  /**
   * Issue #786: per-split drop handlers (drop validation owner / D-1).
   *
   * The container holds the `splits` array, so it is the single place that can
   * classify a drop and resolve a colliding split's index N:
   *   - no-op   (split already shows this cliId)        → nothing, no toast
   *   - reject  (another split already uses this cliId) → warning toast "X is
   *             already in use by split N" (1-based N), no change
   *   - apply   (cliId unused)                          → setSplitCliTool; only
   *             when it returns true do we fire the success toast +
   *             onActiveCliTabChange (single source of truth / S3-005)
   *
   * Stable per-index references (useMemo) so passing them through renderPane
   * does not destabilize the parent's memoized panes (D-3).
   */
  const dropHandlers = useMemo(
    () =>
      splits.map((_, idx) => (cliId: CLIToolType) => {
        // no-op: the drop target split already shows this CLI.
        if (splits[idx]?.cliToolId === cliId) return;
        // reject: another split already uses this CLI (S1-002).
        const collidingIdx = splits.findIndex(
          (s, i) => i !== idx && s.cliToolId === cliId,
        );
        if (collidingIdx !== -1) {
          showToast?.(
            `${getCliToolDisplayName(cliId)} is already in use by split ${collidingIdx + 1}`,
            'warning',
          );
          return;
        }
        // apply: setSplitCliTool returns whether the change was actually applied.
        const applied = setSplitCliTool(idx, cliId);
        if (applied) {
          onActiveCliTabChange?.(cliId);
          showToast?.(
            `Moved ${getCliToolDisplayName(cliId)} to Split ${idx + 1}`,
            'success',
          );
        }
      }),
    [splits, setSplitCliTool, showToast, onActiveCliTabChange],
  );

  return (
    <div
      role="group"
      aria-label="Terminal splits"
      data-testid="terminal-split-container"
      className="flex flex-col h-full min-h-0"
    >
      {/* Action bar */}
      <div className="flex items-center gap-2 px-2 py-1 bg-white dark:bg-gray-900 border-b border-gray-200 dark:border-gray-700 flex-shrink-0">
        <span className="text-xs text-gray-500 dark:text-gray-400">
          {splits.length} / {MAX_SPLITS} splits
        </span>
        <button
          type="button"
          onClick={addSplit}
          disabled={!canAdd}
          aria-disabled={!canAdd}
          aria-label="Add terminal split"
          data-testid="add-terminal-split"
          className="ml-auto text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          + Split
        </button>
        <button
          type="button"
          onClick={removeSplit}
          disabled={!canRemove}
          aria-disabled={!canRemove}
          aria-label="Remove last terminal split"
          data-testid="remove-terminal-split"
          className="text-xs px-2 py-0.5 rounded border border-gray-300 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-700 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          - Split
        </button>
      </div>

      {/* Splits row */}
      <div ref={containerRef} className="flex flex-1 min-h-0 w-full">
        {splits.map((split, idx) => {
          const isLast = idx === splits.length - 1;
          return (
            <React.Fragment key={`split-${idx}`}>
              <div
                style={{
                  flexGrow: widths[idx] ?? 1,
                  flexShrink: 1,
                  flexBasis: 0,
                  minWidth: 0,
                }}
                className="h-full"
              >
                {renderPane({
                  splitIndex: idx,
                  cliToolId: split.cliToolId,
                  availableCliTools: availableCliTools(idx),
                  onCliToolChange: cliChangeHandlers[idx],
                  onFocus: focusHandlers[idx],
                  isFocused: focusedSplitIndex === idx,
                  onDropCliTool: dropHandlers[idx],
                })}
              </div>
              {!isLast ? (
                <PaneResizerWrapper
                  resizerIdx={idx}
                  ariaValueNow={
                    widths.length
                      ? (widths[idx] / widths.reduce((s, x) => s + x, 0)) * 100
                      : 50
                  }
                  onResize={handleResize}
                  onStart={handleResizeStart}
                  onEnd={handleResizeEnd}
                />
              ) : null}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
});

/**
 * Internal helper: wraps PaneResizer so we can intercept the underlying
 * mousedown / touchstart events to mark `isResizing=true` synchronously.
 * `mouseup` clears it.
 */
function PaneResizerWrapper({
  resizerIdx,
  ariaValueNow,
  onResize,
  onStart,
  onEnd,
}: {
  resizerIdx: number;
  ariaValueNow: number;
  onResize: (resizerIdx: number, delta: number) => void;
  onStart: () => void;
  onEnd: () => void;
}) {
  const handleResize = useCallback(
    (delta: number) => onResize(resizerIdx, delta),
    [resizerIdx, onResize],
  );
  return (
    <div
      data-testid={`split-resizer-${resizerIdx}`}
      onMouseDownCapture={onStart}
      onTouchStartCapture={onStart}
      onMouseUpCapture={onEnd}
      onTouchEndCapture={onEnd}
    >
      <PaneResizer
        onResize={handleResize}
        orientation="horizontal"
        ariaValueNow={ariaValueNow}
      />
    </div>
  );
}

export default TerminalSplitContainer;
