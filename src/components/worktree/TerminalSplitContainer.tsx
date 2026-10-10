/**
 * TerminalSplitContainer Component (Issue #728, 2x2 grid in Issue #2421)
 *
 * Hosts 1-4 terminal splits in the PC layout. 1-3 splits are a horizontal row
 * (flex); at exactly 4 the row becomes a 2x2 CSS grid — a quarter-width column
 * cannot show a 200-column agent TUI, and the tmux pane geometry is independent
 * of the browser pane, so the grid is a display change only. Owns:
 *  - split configuration via `useTerminalSplits` (worktreeId-scoped)
 *  - the layout icons (1 / 2 / 3 / 4 splits, Issue #3514 — they replaced the
 *    "n / 4 splits + -" stepper), disabled for counts the roster cannot fill
 *    and while a PaneResizer drag is in progress
 *  - placing an agent added from the header's "+" (Issue #3514) into a new
 *    split or the focused one, once the roster that contains it arrives
 *  - History / "Open Files" visibility toggles in the Action bar (Issue #841,
 *    made the SOLE entry point by Issue #2259 — the vertical collapse strips
 *    are gone), reading the persisted state in useHistoryPaneState /
 *    useFilePanelState and disabled when the panel they name cannot appear
 *  - PaneResizer widget(s) between splits, with width persistence — in the grid
 *    that is exactly two: one vertical column divider and one horizontal row
 *    divider (`orientation="vertical"`), since a grid track is shared by both
 *    of its cells
 *  - the temporary "maximize one split" state (Issue #2261): the Action bar's
 *    restore button, and the `display: none` that hides the other splits
 *    WITHOUT unmounting them, so their sessions and polling keep running.
 *    Issue #2421: in the grid, hiding is not enough — a grid TRACK survives its
 *    children being hidden, so the surviving pane would sit in the top-left
 *    quarter. The grid collapses to a single `1fr` / `1fr` cell while maximized
 *  - delegating each split's body to a parent-supplied `renderPane`
 *
 * Does NOT include HistoryPane (HISTORY_PANE_ID uniqueness is owned by
 * TerminalContainer per Issue #730).
 *
 * a11y: outer container `role="group" aria-label="Terminal splits"`. Each
 * pane itself owns `role="region"` inside TerminalSplitPane.
 */

'use client';

import { TerminalSplitHiddenProvider } from './TerminalSplitHiddenContext';
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
import {
  History,
  PanelRight,
  AlignHorizontalDistributeCenter,
  Square,
  Columns2,
  Columns3,
  LayoutGrid,
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { getInstanceLabel, type AgentInstance, type CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import {
  MAX_SPLITS,
  MIN_GRID_ROW_PX,
  toGridTrackFractions,
  MIN_SPLITS,
  isGridLayout,
  SPLIT_LAYOUT_COUNTS,
  type AgentPlacement,
} from '@/config/terminal-split-config';
import { useTerminalSplits } from '@/hooks/useTerminalSplits';
import {
  useHistoryPaneState,
  DEFAULT_HISTORY_WIDTH,
  splitHistorySlotId,
} from '@/hooks/useHistoryPaneState';
import {
  useFilePanelState,
  useOpenFiles,
  FILE_PANEL_PANE_ID,
} from '@/hooks/useFilePanelState';
import { Tooltip } from '@/components/common/Tooltip';
import { PaneResizer, type ResizerOrientation } from './PaneResizer';

/**
 * Issue #2421: thickness of the grid's two divider TRACKS, in px.
 *
 * A grid divider needs a track of its own (unlike a flex row, where the resizer
 * is just another `flex-shrink-0` child), and the number has to match the line
 * `PaneResizer` draws — `w-1` / `h-1`, i.e. 4px — or the handle would float
 * inside a wider gap.
 */
const GRID_DIVIDER_PX = 4;

/** Issue #2421: 2x2 placement — panes 0/1 on the top row, 2/3 on the bottom. */
function gridColumnOf(idx: number): number {
  // Track 2 is the column divider, so the right-hand column is track 3.
  return idx % 2 === 0 ? 1 : 3;
}

function gridRowOf(idx: number): number {
  // Track 2 is the row divider, so the bottom row is track 3.
  return idx < 2 ? 1 : 3;
}

/**
 * Issue #3514: the glyph for each layout icon — what the terminal area will
 * look like, so 4 reads as the 2x2 grid it actually becomes.
 */
const SPLIT_LAYOUT_ICONS: Record<number, typeof Square> = {
  1: Square,
  2: Columns2,
  3: Columns3,
  4: LayoutGrid,
};

/**
 * Issue #3514: a request to show a just-added agent instance. Token-stamped for
 * the reason `headerInstanceSelection` is: the container applies it exactly
 * once, and only after `instances` contains the new id (the roster PATCH and
 * this request land together, but the request must never be dropped because it
 * raced the roster).
 */
export interface InstancePlacementRequest {
  instanceId: string;
  placement: Exclude<AgentPlacement, 'roster-only'>;
  token: number;
}

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
  /**
   * Issue #3514: draw the "this is the selected split" frame. True for the
   * focused split only while more than one split is open — a lone split is
   * trivially the selected one, and a permanent accent border would be noise.
   */
  showFocusFrame?: boolean;
  /**
   * Issue #2261: whether THIS split is the one currently filling the terminal
   * row. Drives the pressed state of the pane's own maximize/restore toggle.
   */
  isMaximized: boolean;
  /**
   * Issue #2261: maximize this split, or restore the split layout when it is
   * already maximized. Stable per-index reference.
   */
  onToggleMaximize: () => void;
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
  /**
   * Issue #3514: show an agent the header's "+" just added. `new-split` appends
   * a split (falling back to `replace` if the ceiling was reached meanwhile);
   * `replace` swaps it into the focused split. Either way the split that shows
   * it takes focus. Applied once per token, as soon as `instances` holds it.
   */
  instancePlacementRequest?: InstancePlacementRequest | null;
  /** Issue #3514: published whenever the split count changes (the "+" needs it). */
  onSplitCountChange?: (count: number) => void;
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
  instancePlacementRequest,
  onSplitCountChange,
}: TerminalSplitContainerProps) {
  const {
    splits,
    widths,
    rowHeights,
    setRowHeights,
    setSplitCount,
    openInstanceInNewSplit,
    setSplitInstance,
    setSplitWidth,
    resetWidths,
    availableInstanceIds,
    focusedSplitIndex,
    setFocusedSplitIndex,
    maximizedIndex,
    toggleMaximize,
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
  // useFilePanelState), so toggling here reaches every mount of the state.
  //
  // Issue #2259: they are now the ONLY toggles. The vertical collapse strips in
  // `TerminalSplitPaneContent` / `FilePanelSplit` / `TerminalContainer` are
  // gone, so there is one place to look for each switch and hiding a panel
  // returns its full width to the terminal.
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

  /**
   * Issue #3514: place an agent added from the header's "+".
   *
   * Waits for the roster: the request and the PATCHed roster are set in the
   * same handler, but a request whose instance is not in `instances` yet is
   * kept (not consumed) and retried when the roster changes, so it can never
   * be lost to ordering. A `new-split` takes focus through the same
   * "last added" path the layout icons use; a `replace` focuses the split it
   * replaced. Either way the active instance follows, as it does on a drop.
   */
  const lastPlacementTokenRef = useRef(0);
  useEffect(() => {
    if (!instancePlacementRequest) return;
    if (instancePlacementRequest.token === lastPlacementTokenRef.current) return;
    const { instanceId, placement } = instancePlacementRequest;
    if (!instances.some((inst) => inst.id === instanceId)) return; // roster not here yet
    lastPlacementTokenRef.current = instancePlacementRequest.token;
    const current = splitsRef.current;
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx !== -1) {
      setFocusedSplitIndex(shownIdx);
      return;
    }
    if (placement === 'new-split' && openInstanceInNewSplit(instanceId)) {
      onActiveInstanceChange?.(instanceId);
      return;
    }
    // `replace`, or a `new-split` that found no room: the focused split.
    const targetIdx = Math.min(focusedSplitIndex, current.length - 1);
    if (setSplitInstance(targetIdx, instanceId)) {
      setFocusedSplitIndex(targetIdx);
      onActiveInstanceChange?.(instanceId);
    }
  }, [
    instancePlacementRequest,
    instances,
    focusedSplitIndex,
    openInstanceInNewSplit,
    setSplitInstance,
    setFocusedSplitIndex,
    onActiveInstanceChange,
  ]);

  // Issue #3514: the header "+" disables `new-split` at the ceiling.
  useEffect(() => {
    onSplitCountChange?.(splits.length);
  }, [splits.length, onSplitCountChange]);

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

  /*
   * Issue #2421: the grid's two dividers.
   *
   * They cannot reuse `handleResize`: that one walks a 1-D `widths` array where
   * every entry spans the container, while a grid has ONE column ratio
   * (`widths[0] : widths[1]`, shared by both rows because a grid column is) and
   * one row ratio. Feeding it `resizerIdx` would move the boundary at twice the
   * pointer's speed, because the sum it divides by (1.0, all four entries) is
   * twice the share the two visible columns actually occupy.
   */
  /*
   * Issue #2424: the `fr` pairs the grid is actually laid out with.
   *
   * `widths` / `rowHeights` are shares whose total is not pinned to 1 (a fresh
   * grid is `0.25` per pane, and `isValidRowHeights` accepts any positive
   * pair). CSS gives tracks whose flex factors sum below 1 only that fraction
   * of the space, so the raw values have to be normalised before they reach
   * `gridTemplate*`. Derived rather than stored: the resize handlers stay free
   * to preserve whatever total they already use.
   */
  const gridColumnFr = toGridTrackFractions(widths[0] ?? 1, widths[1] ?? 1);
  const gridRowFr = toGridTrackFractions(rowHeights[0] ?? 1, rowHeights[1] ?? 1);

  const handleGridColumnResize = useCallback(
    (_resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const total = widths[0] + widths[1];
      if (!(total > 0)) return;
      const percentDelta = (deltaPx / w) * total;
      const left = widths[0] + percentDelta;
      const right = widths[1] - percentDelta;
      const FLOOR = total * 0.05;
      if (left < FLOOR || right < FLOOR) return;
      // The bottom row mirrors the top so every entry still describes its own
      // pane's horizontal share (the grid reads the ratio off the first two).
      setSplitWidth([left, right, left, right]);
    },
    [widths, setSplitWidth],
  );

  const handleGridRowResize = useCallback(
    (_resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const h = container.offsetHeight;
      if (h === 0) return;
      const total = rowHeights[0] + rowHeights[1];
      if (!(total > 0)) return;
      const percentDelta = (deltaPx / h) * total;
      const top = rowHeights[0] + percentDelta;
      const bottom = rowHeights[1] - percentDelta;
      const FLOOR = total * 0.05;
      if (top < FLOOR || bottom < FLOOR) return;
      setRowHeights([top, bottom]);
    },
    [rowHeights, setRowHeights],
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

  // Issue #3514: a layout needs one distinct roster instance per split, so the
  // icons above the roster size are disabled rather than silently doing nothing.
  const maxSelectableSplits = Math.max(MIN_SPLITS, Math.min(MAX_SPLITS, instances.length));
  // Nothing to equalize when there is a single split AND History is hidden.
  const canEqualize = splits.length > MIN_SPLITS || historyVisible;

  /*
   * Issue #2261: the Action bar's half of the maximize toggle.
   *
   * The per-split button lives in each pane's title bar, which is exactly the
   * thing that is off screen while another split is maximized — so the restore
   * gesture has to exist somewhere that is always visible. It is the SAME
   * toggle, not a separate "restore" command: while nothing is maximized it
   * blows up the focused split, and while something is it restores the layout,
   * so `aria-pressed` here and in the title bar always report the same fact.
   *
   * Disabled at a single split: there is no other split for it to take room
   * from, so flipping the state would render identically.
   */
  const isMaximized = maximizedIndex !== null;
  const canMaximize = splits.length > MIN_SPLITS;
  /**
   * Issue #2421: 4 splits render as a 2x2 grid, everything below as the
   * pre-#2421 flex row. The two branches are kept side by side (rather than
   * generalizing the row into a 1xN grid) so 1-3 splits keep byte-identical
   * layout styles and cannot regress.
   */
  const isGrid = isGridLayout(splits.length);
  const handleToggleMaximize = useCallback(() => {
    toggleMaximize(maximizedIndex ?? focusedSplitIndex);
  }, [toggleMaximize, maximizedIndex, focusedSplitIndex]);
  const maximizeLabel = isMaximized
    ? t('terminal.restoreSplits')
    : t('terminal.maximizeFocusedSplit');
  // [Issue #2307] Tooltip content mirrors the former native `title` text
  // (label + shortcut hint) — only the delivery mechanism changed.
  const maximizeTooltip = `${maximizeLabel} — ${t('terminal.maximizeShortcutHint')}`;

  /*
   * Issue #2259: the Open Files toggle is disabled when the panel it shows
   * cannot appear at all, instead of flipping a state with no visible effect —
   * `FilePanelSplit` renders no panel with no tabs and no diff, which is the
   * "press Files and nothing happens" complaint the Issue opens with. The count
   * rides along as a badge and the icon is `PanelRight` rather than the tree's
   * `Files` (Issue #2616), which is what tells the two "Files" apart at a
   * glance: the Activity Bar's file TREE, and this panel of files you opened
   * from it.
   *
   * The History toggle used to carry the same treatment, disabled while EVERY
   * split showed chat because the chat surface had no History column. Issue
   * #2446 gave chat mode the same `[History column | resizer | output]` row the
   * terminal has, so the column exists in both surfaces and the toggle is
   * unconditionally live again (the `useSplitSurfaceModes` hook that fed the
   * old verdict had no other reader and is gone with it).
   */
  const { tabCount: openFileCount, hasDiff } = useOpenFiles();
  const filesUnavailable = openFileCount === 0 && !hasDiff;
  // [Issue #2307] Tooltip content mirrors the former native `title` text.
  const historyTooltip = `${
    historyVisible ? t('terminal.hideHistory') : t('terminal.showHistory')
  } — ${t('terminal.historyAllSplitsHint')}`;
  const filesTooltip = filesUnavailable
    ? t('terminal.filesEmptyHint')
    : filesVisible
      ? t('terminal.hideFiles')
      : t('terminal.showFiles');
  const historySlotIds = useMemo(
    () => splits.map((_, idx) => splitHistorySlotId(idx)).join(' '),
    [splits],
  );

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

  // Issue #2261: per-split maximize toggles, memoized for the same reason the
  // focus / drop handlers are — they cross `renderPane` into memoized panes.
  const maximizeHandlers = useMemo(
    () => splits.map((_, idx) => () => toggleMaximize(idx)),
    [splits, toggleMaximize],
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
        {/* Issue #2261: while a split is maximized the label says which split is
            filling the row — the one line that explains why the other panes
            vanished. Issue #3514: the "n / 4 splits" count it showed otherwise
            is gone; the pressed layout icon says the same thing. */}
        {isMaximized ? (
          <span
            data-testid="split-count-label"
            className="text-xs text-muted-foreground tabular-nums mr-1 truncate"
          >
            {t('terminal.maximizedStatus', { split: (maximizedIndex ?? 0) + 1 })}
          </span>
        ) : null}

        {/*
          Issue #3514: the layout icons (1 / 2 / 3 / 4) replace the "+ / -"
          stepper. One click goes straight to the layout; 4 is the 2x2 grid.
          Together with Equal / Maximize they form the LEFT group; an `ml-auto`
          hairline separator pushes the History / Files panel toggles to the
          RIGHT group ("layout ops | panel visibility", Issue #1079).
        */}
        <div
          role="group"
          aria-label={t('terminal.layoutGroupLabel')}
          data-testid="split-layout-picker"
          className="flex items-center gap-0.5 rounded border border-border p-0.5"
        >
          {SPLIT_LAYOUT_COUNTS.map((count) => {
            const Icon = SPLIT_LAYOUT_ICONS[count] ?? Square;
            const active = splits.length === count;
            const disabled = isResizing || count > maxSelectableSplits;
            const label = t('terminal.layoutSplits', { count });
            return (
              <Tooltip key={count} content={label} placement="bottom">
                <button
                  type="button"
                  onClick={() => setSplitCount(count)}
                  disabled={disabled}
                  aria-disabled={disabled}
                  aria-pressed={active}
                  aria-label={label}
                  data-testid={`split-layout-${count}`}
                  className={`flex items-center justify-center h-6 w-6 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring ${
                    active
                      ? 'bg-accent-500/15 text-accent-600 dark:text-accent-400'
                      : 'text-muted-foreground hover:text-surface-foreground hover:bg-muted'
                  }`}
                >
                  <Icon className="w-3.5 h-3.5" aria-hidden="true" />
                </button>
              </Tooltip>
            );
          })}
        </div>

        {/*
          Issue #861: equalize terminal split widths (each → 1/n) and reset the
          Message History width to default in one action. Disabled only when
          there is nothing to equalize (single split AND History hidden).
        */}
        <Tooltip content={t('terminal.equalizeWidthsHint')} placement="bottom">
          <button
            type="button"
            onClick={handleEqualizeWidths}
            disabled={!canEqualize}
            aria-disabled={!canEqualize}
            aria-label={t('terminal.equalizeWidthsHint')}
            data-testid="equalize-split-widths"
            className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            <AlignHorizontalDistributeCenter
              className="w-4 h-4 flex-shrink-0"
              aria-hidden="true"
            />
          </button>
        </Tooltip>

        {/* Issue #2261: maximize the focused split / restore the layout. */}
        <Tooltip content={maximizeTooltip} placement="bottom">
          <button
            type="button"
            onClick={handleToggleMaximize}
            disabled={!canMaximize}
            aria-disabled={!canMaximize}
            aria-pressed={isMaximized}
            aria-label={maximizeLabel}
            data-testid="toggle-maximize-split"
            className="flex items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            )}
          </button>
        </Tooltip>

        {/* Issue #1079: separator dividing layout ops (left) from panel toggles
            (right). `ml-auto` pushes the History / Files group to the far right. */}
        <div className="ml-auto h-4 w-px bg-border" aria-hidden="true" />

        {/*
          Issue #841 (Phase 2): History / Files visibility toggles. Always
          shown (split-count independent). Active = cyan accent, inactive =
          gray. `aria-pressed` reflects current visibility. The existing
          vertical collapse strips remain and share this state (SSOT).
        */}
        <Tooltip content={historyTooltip} placement="bottom" className="flex-shrink-0">
          <button
            type="button"
            onClick={toggleHistory}
            aria-pressed={historyVisible}
            aria-expanded={historyVisible}
            aria-controls={historySlotIds}
            aria-label={
              historyVisible
                ? t('terminal.hideHistory')
                : t('terminal.showHistory')
            }
            data-testid="toggle-history-pane"
            className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-xs px-2 py-0.5 rounded border transition-colors ${
              historyVisible
                ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            <History className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{t('terminal.historyLabel')}</span>
          </button>
        </Tooltip>
        <Tooltip content={filesTooltip} placement="bottom" className="flex-shrink-0">
          <button
            type="button"
            onClick={toggleFilePanel}
            disabled={filesUnavailable}
            aria-disabled={filesUnavailable}
            aria-pressed={filesVisible}
            aria-expanded={filesVisible}
            aria-controls={FILE_PANEL_PANE_ID}
            aria-label={
              filesVisible ? t('terminal.hideFiles') : t('terminal.showFiles')
            }
            data-testid="toggle-file-panel"
            className={`flex flex-shrink-0 items-center gap-1 whitespace-nowrap text-xs px-2 py-0.5 rounded border transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              filesVisible
                ? 'border-accent-300 dark:border-accent-700 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300'
                : 'border-gray-300 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700'
            }`}
          >
            {/* Issue #2616: `Files` is the Activity Bar file tree's icon; this
                toggle shows a side panel, so it must not share it. */}
            <PanelRight className="w-3.5 h-3.5 flex-shrink-0" aria-hidden="true" />
            <span>{t('terminal.filesLabel')}</span>
            {openFileCount > 0 && (
              <span
                data-testid="open-files-count"
                className="ml-0.5 min-w-[1.25rem] px-1 rounded-full bg-muted text-[10px] leading-4 text-muted-foreground tabular-nums text-center"
              >
                {openFileCount}
              </span>
            )}
          </button>
        </Tooltip>
      </div>

      {/*
        Splits area.

        Issue #2421: `flex` for 1-3 splits (unchanged), `grid` at 4. The grid is
        3x3 in TRACKS — pane, divider, pane on each axis — so the two dividers
        get real tracks instead of overlaying the panes.

        `overflow-y-auto` is the other half of the MIN_GRID_ROW_PX floor: the
        rows' `minmax()` refuses to shrink past it, so on a viewport too short
        for two usable rows the grid scrolls rather than crushing both panes into
        a few lines of terminal.
      */}
      <div
        ref={containerRef}
        data-testid="terminal-split-layout"
        data-layout={isGrid ? 'grid' : 'row'}
        className={
          isGrid
            ? 'grid flex-1 min-h-0 w-full overflow-y-auto'
            : 'flex flex-1 min-h-0 w-full'
        }
        style={
          isGrid
            ? {
                // Issue #2421 (trap 2): a grid track survives its children being
                // hidden, so `display: none` alone would leave the maximized
                // pane in the top-left quarter. While maximized the grid IS one
                // cell.
                // Issue #2424: normalised, NOT the raw shares. A fresh grid
                // carries `0.25` per pane, and `0.25fr + 0.25fr` sums to less
                // than 1 — which CSS reads as "take half the leftover space"
                // rather than "split it evenly", leaving the right ~50% blank.
                gridTemplateColumns: isMaximized
                  ? '1fr'
                  : `${gridColumnFr[0]}fr ${GRID_DIVIDER_PX}px ${gridColumnFr[1]}fr`,
                gridTemplateRows: isMaximized
                  ? '1fr'
                  : `minmax(${MIN_GRID_ROW_PX}px, ${gridRowFr[0]}fr) ${GRID_DIVIDER_PX}px minmax(${MIN_GRID_ROW_PX}px, ${gridRowFr[1]}fr)`,
              }
            : undefined
        }
      >
        {splits.map((split, idx) => {
          const isLast = idx === splits.length - 1;
          /*
           * Issue #2261: `display: none`, NOT `flexGrow: 0`.
           *
           * A zero-grow flex child is still laid out (at width 0) and still
           * reports a zero-height/zero-width box to every `measureElement` the
           * virtualized transcript inside it runs, which corrupts the measured
           * cache it restores from on the way back. `display: none` takes the
           * subtree out of layout entirely, and — crucially — leaves it MOUNTED:
           * the hidden splits' sessions, polling and scroll positions survive,
           * so restoring shows output that kept arriving.
           */
          const hidden = maximizedIndex !== null && maximizedIndex !== idx;
          const maximizedHere = maximizedIndex === idx;
          return (
            <React.Fragment key={`split-${idx}`}>
              <div
                data-testid={`split-wrapper-${idx}`}
                data-hidden={hidden ? 'true' : undefined}
                style={
                  isGrid
                    ? {
                        // The maximized pane moves to the single collapsed cell;
                        // everyone else keeps their 2x2 slot (they are hidden, so
                        // the placement is inert, and restoring needs no
                        // re-derivation).
                        gridColumn: maximizedHere ? 1 : gridColumnOf(idx),
                        gridRow: maximizedHere ? 1 : gridRowOf(idx),
                        minWidth: 0,
                        minHeight: 0,
                        ...(hidden ? { display: 'none' } : null),
                      }
                    : {
                        flexGrow: maximizedHere ? 1 : (widths[idx] ?? 1),
                        flexShrink: 1,
                        flexBasis: 0,
                        minWidth: 0,
                        ...(hidden ? { display: 'none' } : null),
                      }
                }
                className="h-full"
              >
                <TerminalSplitHiddenProvider value={hidden}>
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
                  showFocusFrame: splits.length > MIN_SPLITS && focusedSplitIndex === idx,
                  onDropInstance: dropHandlers[idx],
                  isMaximized: maximizedHere,
                  onToggleMaximize: maximizeHandlers[idx],
                })}
                </TerminalSplitHiddenProvider>
              </div>
              {!isGrid && !isLast ? (
                <PaneResizerWrapper
                  resizerIdx={idx}
                  // Issue #2261: there is no boundary to drag while one split
                  // owns the whole row; the handle comes back on restore.
                  hidden={maximizedIndex !== null}
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

        {/*
          Issue #2421: the grid's two dividers, rendered after the panes because
          each carries its own explicit track placement — a grid column is shared
          by both of its cells, so there is one column divider spanning both rows
          and one row divider spanning both columns, not one per pane boundary.
        */}
        {isGrid ? (
          <>
            <PaneResizerWrapper
              resizerIdx={0}
              testId="split-grid-column-resizer"
              gridArea={{ gridColumn: 2, gridRow: '1 / span 3' }}
              hidden={isMaximized}
              ariaValueNow={(widths[0] / (widths[0] + widths[1])) * 100}
              onResize={handleGridColumnResize}
              onStart={handleResizeStart}
              onEnd={handleResizeEnd}
              onDoubleClick={resetWidths}
            />
            <PaneResizerWrapper
              resizerIdx={0}
              testId="split-grid-row-resizer"
              orientation="vertical"
              gridArea={{ gridColumn: '1 / span 3', gridRow: 2 }}
              hidden={isMaximized}
              ariaValueNow={(rowHeights[0] / (rowHeights[0] + rowHeights[1])) * 100}
              onResize={handleGridRowResize}
              onStart={handleResizeStart}
              onEnd={handleResizeEnd}
              onDoubleClick={resetWidths}
            />
          </>
        ) : null}
      </div>
    </div>
  );
});

/**
 * Internal helper: wraps PaneResizer so we can intercept the underlying
 * mousedown / touchstart events to mark `isResizing=true` synchronously.
 * `mouseup` clears it.
 *
 * Issue #2421: also carries the grid's two dividers, which differ from the row's
 * only in orientation, track placement and test id — the drag / touch / keyboard
 * machinery is the same `PaneResizer` either way (its `orientation="vertical"`
 * branch had no caller in `src/` before this Issue).
 */
function PaneResizerWrapper({
  resizerIdx,
  ariaValueNow,
  onResize,
  onStart,
  onEnd,
  onDoubleClick,
  hidden = false,
  orientation = 'horizontal',
  testId,
  gridArea,
}: {
  resizerIdx: number;
  ariaValueNow: number;
  onResize: (resizerIdx: number, delta: number) => void;
  onStart: () => void;
  onEnd: () => void;
  /** Issue #861: double-clicking the resizer equalizes terminal split widths. */
  onDoubleClick?: () => void;
  /** Issue #2261: hidden (but mounted) while a split is maximized. */
  hidden?: boolean;
  /** Issue #2421: `vertical` drives the grid's row divider (row-resize / clientY). */
  orientation?: ResizerOrientation;
  /** Issue #2421: overrides the row layout's positional id for the grid dividers. */
  testId?: string;
  /** Issue #2421: explicit grid placement; omitted in the flex row. */
  gridArea?: { gridColumn: number | string; gridRow: number | string };
}) {
  const handleResize = useCallback(
    (delta: number) => onResize(resizerIdx, delta),
    [resizerIdx, onResize],
  );
  return (
    <div
      data-testid={testId ?? `split-resizer-${resizerIdx}`}
      style={{ ...gridArea, ...(hidden ? { display: 'none' } : null) }}
      onMouseDownCapture={onStart}
      onTouchStartCapture={onStart}
      onMouseUpCapture={onEnd}
      onTouchEndCapture={onEnd}
    >
      <PaneResizer
        onResize={handleResize}
        orientation={orientation}
        ariaValueNow={ariaValueNow}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}

export default TerminalSplitContainer;
