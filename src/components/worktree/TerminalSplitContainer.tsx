/**
 * TerminalSplitContainer Component (Issue #728)
 *
 * Hosts 1-3 horizontal terminal splits in the PC layout. Owns:
 *  - split configuration via `useTerminalSplits` (worktreeId-scoped)
 *  - add / remove buttons (disabled at the MIN / MAX boundary and while
 *    a PaneResizer drag is in progress)
 *  - History / Files visibility toggles in the Action bar (Issue #841): a
 *    second entry point alongside the existing vertical collapse strips, both
 *    reading the same persisted state (useHistoryPaneState / useFilePanelState)
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
import { useTranslations } from 'next-intl';
import { History, Files, AlignHorizontalDistributeCenter, Plus, Minus } from 'lucide-react';
import { getInstanceLabel, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import { MAX_SPLITS, MIN_SPLITS } from '@/config/terminal-split-config';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import {
  useHistoryPaneState,
  DEFAULT_HISTORY_WIDTH,
} from '@/hooks/useHistoryPaneState';
import { useFilePanelState } from '@/hooks/useFilePanelState';
import { PaneResizer } from './PaneResizer';

/** Render-prop signature: each pane is supplied externally so the
 *  container does not need to know about MessageInput / TerminalDisplay. */
export interface RenderTerminalSplitPaneArgs {
  splitIndex: number;
  cliToolId: CLIToolType;
  /** Issue #869: agent instance backing this split (tab/split identity). */
  instanceId: string;
  /** Issue #869: the resolved instance (for alias display); undefined if stale. */
  instance: AgentInstance | undefined;
  /** Issue #869: instances selectable for this split (excludes ones used by other splits). */
  availableInstances: AgentInstance[];
  onInstanceChange: (instanceId: string) => void;
  onFocus: () => void;
  isFocused: boolean;
  /**
   * Issue #786 / #869: handle an agent instance dropped onto this split. The
   * container owns the no-op / reject / apply classification (it holds the
   * `splits` array), so the pane just forwards the dropped instanceId here.
   * Stable per-index reference.
   */
  onDropInstance: (instanceId: string) => void;
}

export interface TerminalSplitContainerProps {
  worktreeId: string;
  /** Issue #869: the worktree's agent-instance roster (drives split identity). */
  instances: AgentInstance[];
  /**
   * Issue #898: `true` once `instances` is the REAL roster for `worktreeId`
   * (not the transient seed/default shown before the API responds or right
   * after a sidebar worktree switch). Gates the split reconcile so persisted
   * alias splits (`claude-2`) are not evicted against an incomplete roster.
   * Optional (defaults to `true`) for callers/tests that always pass a concrete
   * roster.
   */
  rosterReady?: boolean;
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
   * Issue #786 / #869 (S1-005): called with the new instanceId after a
   * successful drop so the parent can sync the (worktree-global) active
   * instance to the drop target split. Fires only when the change is applied.
   */
  onActiveInstanceChange?: (instanceId: string) => void;
  /**
   * Issue #1152: a header-initiated instance selection to route into the PRIMARY
   * split (split 0), wiring the DesktopHeader instance switcher to the terminal
   * that actually polls output / sends messages.
   *
   * Distinct from `onActiveInstanceChange` (which flows split→active): this flows
   * header→split. It is a token-stamped object rather than a bare instanceId so
   * the container applies it exactly ONCE per header click — the many OTHER
   * mutations of the worktree-global `activeInstanceId` (the split 0→active
   * mirror, drag-drop, roster reconcile, localStorage restore) must NOT reassign
   * a split, and a value-watching effect could not tell those apart. The parent
   * bumps `token` on every pill click; the container ignores repeats.
   *
   * Collision policy (S1-002 preserved — an instance never occupies two splits):
   * when the selected instance is already shown in ANOTHER split, focus moves to
   * that split (focus-move) instead of reassigning — non-destructive, and it
   * satisfies the user's intent to interact with that instance. When it is shown
   * nowhere, it is bound to split 0. When split 0 already shows it, it is a no-op.
   */
  headerInstanceSelection?: { instanceId: string; token: number } | null;
}

export const TerminalSplitContainer = memo(function TerminalSplitContainer({
  worktreeId,
  instances,
  rosterReady = true,
  renderPane,
  onFocusedSplitChange,
  showToast,
  onActiveInstanceChange,
  headerInstanceSelection,
}: TerminalSplitContainerProps) {
  const {
    splits,
    widths,
    addSplit,
    removeSplit,
    setSplitInstance,
    setSplitWidth,
    resetWidths,
    availableInstanceIds,
    focusedSplitIndex,
    setFocusedSplitIndex,
  } = useTerminalSplits(worktreeId, instances, rosterReady);

  // Stable lookup from instanceId → AgentInstance for label / availability.
  const instanceById = useMemo(() => {
    const map = new Map<string, AgentInstance>();
    for (const inst of instances) map.set(inst.id, inst);
    return map;
  }, [instances]);

  const t = useTranslations('worktree');

  // Issue #841 (Phase 2): the Action bar hosts History / Files visibility
  // toggles. These hooks broadcast across instances (useHistoryPaneState /
  // useFilePanelState), so toggling here is the single source of truth shared
  // with the existing vertical collapse strips — both stay in sync.
  const {
    visible: historyVisible,
    toggle: toggleHistory,
    setWidth: setHistoryWidth,
  } = useHistoryPaneState();
  const { collapsed: filePanelCollapsed, toggle: toggleFilePanel } =
    useFilePanelState();
  // The file panel hook stores `collapsed`; "Files visible" is its inverse.
  const filesVisible = !filePanelCollapsed;

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

  /**
   * Issue #1152: apply a header-initiated instance selection to the PRIMARY
   * split, wiring the header instance switcher to the terminal that actually
   * polls output / sends messages. Gated on `token` (not the instanceId) so it
   * runs exactly once per header click and never fires on mount, roster
   * reconcile, localStorage restore, the split 0→active mirror, or a drop — all
   * of which mutate the shared `activeInstanceId` but must NOT reassign a split.
   *
   * `splits` is intentionally omitted from the deps: only a NEW token should
   * trigger this. The classification reads the latest `splits` through a ref so a
   * stale closure cannot mis-target the primary split.
   */
  const lastHeaderTokenRef = useRef(0);
  const splitsRef = useRef(splits);
  splitsRef.current = splits;
  useEffect(() => {
    if (!headerInstanceSelection) return;
    if (headerInstanceSelection.token === lastHeaderTokenRef.current) return;
    lastHeaderTokenRef.current = headerInstanceSelection.token;
    const { instanceId } = headerInstanceSelection;
    const current = splitsRef.current;
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx === 0) return; // primary split already shows it — no-op
    if (shownIdx > 0) {
      // Collision (S1-002): the instance already occupies another split. Surface
      // that split (focus-move) instead of duplicating/reassigning it.
      setFocusedSplitIndex(shownIdx);
      return;
    }
    // Not shown anywhere → bind it to the primary split (split 0), symmetric with
    // the existing split 0→active mirror. Focus the primary split on success.
    if (setSplitInstance(0, instanceId)) {
      setFocusedSplitIndex(0);
    }
  }, [headerInstanceSelection, setSplitInstance, setFocusedSplitIndex]);

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

  // Issue #861: equalize the visible terminal split widths (each → 1/n) AND
  // reset the (split-shared) Message History width to its default. History width
  // lives in a sibling useHistoryPaneState instance inside each pane; setWidth
  // broadcasts via CustomEvent so those instances re-render at the new width.
  const handleEqualizeWidths = useCallback(() => {
    resetWidths();
    setHistoryWidth(DEFAULT_HISTORY_WIDTH);
  }, [resetWidths, setHistoryWidth]);

  const canAdd = splits.length < MAX_SPLITS && !isResizing;
  const canRemove = splits.length > MIN_SPLITS && !isResizing;
  // Nothing to equalize when there is a single split AND History is hidden.
  const canEqualize = splits.length > MIN_SPLITS || historyVisible;

  // Memoize per-split onFocus handlers so prop identity is stable.
  const focusHandlers = useMemo(
    () => splits.map((_, idx) => () => setFocusedSplitIndex(idx)),
    [splits, setFocusedSplitIndex],
  );

  const instanceChangeHandlers = useMemo(
    () =>
      splits.map((_, idx) => (instanceId: string) => setSplitInstance(idx, instanceId)),
    [splits, setSplitInstance],
  );

  /**
   * Issue #786 / #869: per-split drop handlers (drop validation owner / D-1).
   *
   * The container holds the `splits` array, so it is the single place that can
   * classify a drop and resolve a colliding split's index N:
   *   - no-op   (split already shows this instance)        → nothing, no toast
   *   - reject  (another split already uses this instance) → warning toast
   *             "X is already in use by split N" (1-based N), no change
   *   - apply   (instance unused)                          → setSplitInstance;
   *             only when it returns true do we fire the success toast +
   *             onActiveInstanceChange (single source of truth / S3-005)
   *
   * Stable per-index references (useMemo) so passing them through renderPane
   * does not destabilize the parent's memoized panes (D-3).
   */
  const dropHandlers = useMemo(
    () =>
      splits.map((_, idx) => (instanceId: string) => {
        const label = getInstanceLabel(
          instanceById.get(instanceId) ?? { cliTool: 'claude', alias: instanceId },
        );
        // no-op: the drop target split already shows this instance.
        if (splits[idx]?.instanceId === instanceId) return;
        // reject: another split already uses this instance (S1-002).
        const collidingIdx = splits.findIndex(
          (s, i) => i !== idx && s.instanceId === instanceId,
        );
        if (collidingIdx !== -1) {
          showToast?.(
            `${label} is already in use by split ${collidingIdx + 1}`,
            'warning',
          );
          return;
        }
        // apply: setSplitInstance returns whether the change was actually applied.
        const applied = setSplitInstance(idx, instanceId);
        if (applied) {
          onActiveInstanceChange?.(instanceId);
          showToast?.(`Moved ${label} to Split ${idx + 1}`, 'success');
        }
      }),
    [splits, setSplitInstance, showToast, onActiveInstanceChange, instanceById],
  );

  return (
    <div
      role="group"
      aria-label="Terminal splits"
      data-testid="terminal-split-container"
      className="flex flex-col h-full min-h-0"
    >
      {/* Action bar */}
      <div className="flex items-center gap-1 px-2 py-1 bg-surface border-b border-border flex-shrink-0">
        <span className="text-xs text-muted-foreground tabular-nums mr-1">
          {splits.length} / {MAX_SPLITS} splits
        </span>

        {/*
          Issue #1079: the layout-operation controls (+Split / -Split / Equal)
          are lucide icon ghost buttons with tooltips. They form the LEFT group;
          an `ml-auto` hairline separator pushes the History / Files panel
          toggles to the RIGHT group ("layout ops | panel visibility").
        */}
        <button
          type="button"
          onClick={addSplit}
          disabled={!canAdd}
          aria-disabled={!canAdd}
          aria-label={t('terminal.addSplit')}
          title={t('terminal.addSplit')}
          data-testid="add-terminal-split"
          className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <Plus className="w-4 h-4" aria-hidden="true" />
        </button>
        <button
          type="button"
          onClick={removeSplit}
          disabled={!canRemove}
          aria-disabled={!canRemove}
          aria-label={t('terminal.removeSplit')}
          title={t('terminal.removeSplit')}
          data-testid="remove-terminal-split"
          className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <Minus className="w-4 h-4" aria-hidden="true" />
        </button>

        {/*
          Issue #861: equalize terminal split widths (each → 1/n) and reset the
          Message History width to default in one action. Disabled only when
          there is nothing to equalize (single split AND History hidden).
        */}
        <button
          type="button"
          onClick={handleEqualizeWidths}
          disabled={!canEqualize}
          aria-disabled={!canEqualize}
          aria-label={t('terminal.equalizeWidthsHint')}
          title={t('terminal.equalizeWidthsHint')}
          data-testid="equalize-split-widths"
          className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <AlignHorizontalDistributeCenter
            className="w-4 h-4 flex-shrink-0"
            aria-hidden="true"
          />
        </button>

        {/* Issue #1079: separator dividing layout ops (left) from panel toggles
            (right). `ml-auto` pushes the History / Files group to the far right. */}
        <div className="ml-auto h-4 w-px bg-border" aria-hidden="true" />

        {/*
          Issue #841 (Phase 2): History / Files visibility toggles. Always
          shown (split-count independent). Active = cyan accent, inactive =
          gray. `aria-pressed` reflects current visibility. The existing
          vertical collapse strips remain and share this state (SSOT).
        */}
        <button
          type="button"
          onClick={toggleHistory}
          aria-pressed={historyVisible}
          aria-label={
            historyVisible
              ? t('terminal.hideHistory')
              : t('terminal.showHistory')
          }
          title={
            historyVisible
              ? t('terminal.hideHistory')
              : t('terminal.showHistory')
          }
          data-testid="toggle-history-pane"
          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
            historyVisible
              ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
              : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <History className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{t('terminal.historyLabel')}</span>
        </button>
        <button
          type="button"
          onClick={toggleFilePanel}
          aria-pressed={filesVisible}
          aria-label={
            filesVisible ? t('terminal.hideFiles') : t('terminal.showFiles')
          }
          title={
            filesVisible ? t('terminal.hideFiles') : t('terminal.showFiles')
          }
          data-testid="toggle-file-panel"
          className={`flex items-center gap-1 text-xs px-2 py-0.5 rounded border transition-colors ${
            filesVisible
              ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
              : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
          }`}
        >
          <Files className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
          <span>{t('terminal.filesLabel')}</span>
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
                  instanceId: split.instanceId,
                  instance: instanceById.get(split.instanceId),
                  availableInstances: availableInstanceIds(idx)
                    .map(id => instanceById.get(id))
                    .filter((inst): inst is AgentInstance => inst !== undefined),
                  onInstanceChange: instanceChangeHandlers[idx],
                  onFocus: focusHandlers[idx],
                  isFocused: focusedSplitIndex === idx,
                  onDropInstance: dropHandlers[idx],
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
                  onDoubleClick={resetWidths}
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
  onDoubleClick,
}: {
  resizerIdx: number;
  ariaValueNow: number;
  onResize: (resizerIdx: number, delta: number) => void;
  onStart: () => void;
  onEnd: () => void;
  /** Issue #861: double-clicking the resizer equalizes terminal split widths. */
  onDoubleClick?: () => void;
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
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

export default TerminalSplitContainer;
