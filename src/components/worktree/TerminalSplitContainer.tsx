
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
 *  - with ONE split, the action bar's two slots its title bar's controls are
 *    portalled into instead (Issue #3592, `SplitPaneHeaderControls`), so the
 *    lone split has no title bar of its own
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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import {
  Ellipsis,
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
import { useSplitActionBarFit } from '@/hooks/useDesktopHeaderFit';
import { PaneResizer, type ResizerOrientation } from './PaneResizer';
import { SplitHeaderSlotsProvider, type SplitHeaderSlots } from './SplitPaneHeaderControls';
import { isUnhandledEscape } from '@/lib/escape-key';

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

/** Issue #3593: what `onSelectedSplitChange` publishes. */
export interface SelectedSplit {
  /** The selected (focused) split's index. */
  index: number;
  /** The instance that split shows. */
  instanceId: string;
  /** Each split's instance, by split index. */
  splitInstanceIds: string[];
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
  /** Issue #3612: a lone split cannot be maximized (entries disabled). */
  maximizeDisabled: boolean;
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
   * Issue #1152: a header-initiated instance selection to route into the
   * SELECTED split (split 0 until Issue #3593), wiring the DesktopHeader
   * instance switcher to the terminal that actually polls output / sends
   * messages.
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
   * nowhere, it is bound to the selected split. When the selected split already
   * shows it, it is a no-op.
   */
  headerInstanceSelection?: { instanceId: string; token: number } | null;
  /**
   * Issue #3514: show an agent the header's "+" just added. `new-split` appends
   * a split (falling back to `replace` if the ceiling was reached meanwhile);
   * `replace` swaps it into the focused split. Either way the split that shows
   * it takes focus. Applied once per token, as soon as `instances` holds it.
   */
  instancePlacementRequest?: InstancePlacementRequest | null;
  /**
   * Issue #3514: called with the request's token once it has been handled
   * (placed, or focus moved to the split already showing it). The parent must
   * drop that request: the guard against re-applying it lives in a ref, and a
   * remount of this container resets it.
   */
  onInstancePlacementApplied?: (token: number) => void;
  /** Issue #3514: published whenever the split count changes (the "+" needs it). */
  onSplitCountChange?: (count: number) => void;
  /**
   * Issue #3593: the selected split — its index, the instance it shows, and the
   * instance of every split by index. Published on mount and whenever any of
   * them changes. The worktree screen makes this instance its active one, so
   * the header's current session and what End / Auto Yes act on are one value.
   */
  onSelectedSplitChange?: (selection: SelectedSplit) => void;
  /**
   * Issue #3590: what the worktree screen puts on this action bar — the second
   * row under the header — drawn right after the layout ops (layout icons,
   * Equal, Maximize) and before the History / Files toggles.
   *
   * **The one entry point for the second row.** Today it carries the
   * Verification chip (moved here from the header). Later additions (#3591,
   * #3592, #3593) go into this same node — a fragment of several items is
   * fine — rather than into new props, so the bar keeps a single place whose
   * width is fitted: the slot is `min-w-0` and capped at 360px, its content
   * may truncate, and when it still does not fit the History / Files toggles
   * drop their labels, then the whole node moves into a floating panel behind
   * a "…" button that never shrinks, and only then the layout ops clip
   * (`useSplitActionBarFit`). Since #3592 the node is NOT remounted when it
   * moves between the bar and the panel (it is rendered once and its DOM is
   * moved), but it still is when `FilePanelSplit` moves the terminal, so state
   * an item must keep across that belongs in the parent — see
   * `useDesktopVerificationChip`. Popovers an item opens
   * should float out of the bar (the chip's `popover="floating"`) and carry
   * `data-floating-layer` so a press in them does not close the panel.
   *
   * **Height and the display size.** The bar is `h-9` (2.25rem: 36px at the
   * medium display size, 31.5px at small, 28.1px at xsmall) with a 35px
   * floor (`min-h-[35px]`, border included), because items sized in px do
   * not scale with the display size: the chip's ⓘ is a fixed 32px plus the
   * chip's 1px border on each side, 34px. Keep each item at or under 34px.
   * A slot rather than the chip itself so this module keeps no dependency on
   * the verification client. Omitted renders the pre-#3590 bar.
   *
   * Issue #3592: the lone split's title-bar controls do NOT come through here
   * — they belong to the split (its surface mode, its polled cost, its note
   * editor), and lifting them into the parent would re-create the split on
   * every 1 ↔ 2 switch. They are portalled into two slots this bar renders
   * itself with one split (`SplitPaneHeaderControls`): right after this node,
   * in the same fitted left group, and left of History / Files. The session
   * slot is measured with the group (its content re-measures as it changes)
   * and folds behind the same "…" as this node.
   */
  actionBarItems?: ReactNode;
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
  onInstancePlacementApplied,
  onSplitCountChange,
  onSelectedSplitChange,
  actionBarItems,
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
   * Issue #1152: apply a header-initiated instance selection to the selected
   * split (Issue #3593; split 0 before), wiring the header instance switcher to the terminal that actually
   * polls output / sends messages. Gated on `token` (not the instanceId) so it
   * runs exactly once per header click and never fires on mount, roster
   * reconcile, localStorage restore, the split 0→active mirror, or a drop — all
   * of which mutate the shared `activeInstanceId` but must NOT reassign a split.
   *
   * `splits` is intentionally omitted from the deps: only a NEW token should
   * trigger this. The classification reads the latest `splits` through a ref so a
   * stale closure cannot mis-target the split.
   */
  const lastHeaderTokenRef = useRef(0);
  const splitsRef = useRef(splits);
  splitsRef.current = splits;
  const focusedSplitIndexRef = useRef(focusedSplitIndex);
  focusedSplitIndexRef.current = focusedSplitIndex;
  useEffect(() => {
    if (!headerInstanceSelection) return;
    if (headerInstanceSelection.token === lastHeaderTokenRef.current) return;
    lastHeaderTokenRef.current = headerInstanceSelection.token;
    const { instanceId } = headerInstanceSelection;
    const current = splitsRef.current;
    // Issue #3593: the selected split, not split 0 — the header's current
    // session is the one the selected split shows, so that is where a session
    // picked in the header goes.
    const targetIdx = Math.min(focusedSplitIndexRef.current, current.length - 1);
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx === targetIdx) return; // the selected split already shows it — no-op
    if (shownIdx !== -1) {
      // Collision (S1-002): the instance already occupies another split. Surface
      // that split (focus-move) instead of duplicating/reassigning it.
      setFocusedSplitIndex(shownIdx);
      return;
    }
    // Not shown anywhere → bind it to the selected split, and keep it selected.
    if (setSplitInstance(targetIdx, instanceId)) {
      setFocusedSplitIndex(targetIdx);
    }
  }, [headerInstanceSelection, setSplitInstance, setFocusedSplitIndex]);

  // Issue #3593: publish the selected split. Keyed on the values, so a new
  // `splits` array with the same instances does not re-publish.
  const selectedSplitKey = `${focusedSplitIndex}|${splits.map((s) => s.instanceId).join(',')}`;
  useEffect(() => {
    if (!onSelectedSplitChange) return;
    const current = splitsRef.current;
    if (current.length === 0) return;
    const index = Math.min(focusedSplitIndexRef.current, current.length - 1);
    onSelectedSplitChange({
      index,
      instanceId: current[index].instanceId,
      splitInstanceIds: current.map((s) => s.instanceId),
    });
  }, [selectedSplitKey, onSelectedSplitChange]);

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
    const { token } = instancePlacementRequest;
    lastPlacementTokenRef.current = token;
    const current = splitsRef.current;
    const shownIdx = current.findIndex((s) => s.instanceId === instanceId);
    if (shownIdx !== -1) {
      setFocusedSplitIndex(shownIdx);
    } else if (placement === 'new-split' && openInstanceInNewSplit(instanceId)) {
      onActiveInstanceChange?.(instanceId);
    } else {
      // `replace`, or a `new-split` that found no room: the focused split.
      const targetIdx = Math.min(focusedSplitIndex, current.length - 1);
      if (setSplitInstance(targetIdx, instanceId)) {
        setFocusedSplitIndex(targetIdx);
        onActiveInstanceChange?.(instanceId);
      }
    }
    // Handled either way: the parent drops it so a remount cannot re-apply it.
    onInstancePlacementApplied?.(token);
  }, [
    instancePlacementRequest,
    instances,
    focusedSplitIndex,
    openInstanceInNewSplit,
    setSplitInstance,
    setFocusedSplitIndex,
    onActiveInstanceChange,
    onInstancePlacementApplied,
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

  // Issue #3590: the bar's width fit, the second row's counterpart of the
  // header's #2481 fit. Keyed by what changes its widths; the slotted items
  // are a node and re-measure without a key.
  const actionBarRef = useRef<HTMLDivElement>(null);
  const actionBarLeftRef = useRef<HTMLDivElement>(null);
  /*
   * Issue #3592: with one split, its title bar's controls move into the bar —
   * the session ones right of the slotted items, the actions left of History /
   * Files — and the split draws no title bar. The slots are elements in state
   * (callback refs) so the split re-renders into them once they exist; the
   * ref is set during the commit, so that re-render happens before paint.
   */
  const singleSplit = splits.length === MIN_SPLITS;
  const [sessionSlotEl, setSessionSlotEl] = useState<HTMLDivElement | null>(null);
  const [actionsSlotEl, setActionsSlotEl] = useState<HTMLDivElement | null>(null);

  const actionBarFitKey = [
    t('terminal.historyLabel'),
    t('terminal.filesLabel'),
    openFileCount,
    isMaximized ? `max:${maximizedIndex ?? 0}` : '',
    // Issue #3592: the lone split's controls come and go with the count.
    singleSplit ? 'one' : '',
  ].join('\n');
  /*
   * Issue #3592: the items (the Verification chip) are rendered ONCE, into a
   * host element this bar owns, and that element is moved between the places
   * they are shown — inline in the left group, or the "…" panel when folded.
   * Rendering `{actionBarItems}` in each place re-created the chip at every
   * move, and with it its open reason; a move is now a DOM move, so the chip
   * keeps its state through the fit's steps and the split count's changes
   * (the count re-keys the fit). In the bar the host itself is the items'
   * 360px box (`split-action-bar-items`), a child of the left group placed
   * right after a hidden anchor; in the panel it is `display: contents` inside
   * the panel's place — so each place lays the items out exactly as before.
   * Attached from the places' ref callbacks — during the commit, before the
   * fit measures — and taken out of the left group when its anchor goes.
   */
  const [itemsHost, setItemsHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    setItemsHost(document.createElement('div'));
  }, []);
  const itemsAnchorRef = useRef<HTMLElement | null>(null);
  const attachItemsInline = useCallback(
    (anchor: HTMLSpanElement | null) => {
      const previous = itemsAnchorRef.current;
      itemsAnchorRef.current = anchor;
      if (!itemsHost) return;
      if (!anchor) {
        // The anchor is leaving: the host must not stay behind in the group.
        if (previous && itemsHost.previousSibling === previous) itemsHost.remove();
        return;
      }
      // Same width rule the header gave the chip (#2481): a 360px `w-*` capped
      // by `max-w-max`, `min-w-0` so its title truncates.
      itemsHost.className = 'ml-1 flex min-w-0 w-[360px] max-w-max items-center gap-1';
      itemsHost.style.display = '';
      itemsHost.setAttribute('data-testid', 'split-action-bar-items');
      if (itemsHost.previousSibling !== anchor) anchor.after(itemsHost);
    },
    [itemsHost],
  );
  const attachItemsFolded = useCallback(
    (place: HTMLDivElement | null) => {
      if (!place || !itemsHost) return;
      itemsHost.className = '';
      itemsHost.style.display = 'contents';
      itemsHost.removeAttribute('data-testid');
      if (itemsHost.parentNode !== place) place.appendChild(itemsHost);
    },
    [itemsHost],
  );
  // The fit's unkeyed content: the items, and the host they are drawn into
  // (it arrives one commit after the first render).
  const actionBarItemsContent = useMemo(
    () => [actionBarItems, itemsHost],
    [actionBarItems, itemsHost],
  );
  const actionBarFit = useSplitActionBarFit(
    actionBarRef,
    actionBarLeftRef,
    actionBarFitKey,
    actionBarItemsContent,
    // Issue #3592: portalled in by the split, so no prop of ours changes when
    // its model, cost or note does — the slot is watched instead.
    sessionSlotEl
  );
  // Issue #3592: the lone split's session controls fold with the items.
  const sessionFolded = singleSplit && actionBarFit.itemsFolded;
  const sessionSlot = singleSplit ? (
    <div
      ref={setSessionSlotEl}
      data-testid="split-action-bar-session"
      className={`flex min-w-0 items-center${sessionFolded ? ' max-w-full' : ' ml-1'}`}
    />
  ) : null;
  const headerSlots = useMemo<SplitHeaderSlots | null>(
    () =>
      singleSplit && sessionSlotEl && actionsSlotEl
        ? { session: sessionSlotEl, actions: actionsSlotEl }
        : null,
    [singleSplit, sessionSlotEl, actionsSlotEl],
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
          // Issue #3593: the split dropped on becomes the selected one, so the
          // header's current session (the selected split's) is the session
          // just dropped — the same instance the active one now follows.
          setFocusedSplitIndex(idx);
          onActiveInstanceChange?.(instanceId);
          showToast?.(`Moved ${label} to Split ${idx + 1}`, 'success');
        }
      }),
    [splits, setSplitInstance, setFocusedSplitIndex, showToast, onActiveInstanceChange, instanceById],
  );

  return (
    <div
      role="group"
      aria-label="Terminal splits"
      data-testid="terminal-split-container"
      className="flex flex-col h-full min-h-0"
    >
      {/* Action bar. Issue #3590: the worktree screen's second row — 36px
          including its border (the Verification chip's ⓘ is 32px plus the
          chip's 1px border on each side, so no vertical padding). */}
      <div
        ref={actionBarRef}
        data-testid="split-action-bar"
        className="flex h-9 min-h-[35px] items-center gap-1 px-2 bg-surface border-b border-border flex-shrink-0"
      >
        {/* Issue #3590: the left group (layout ops + `actionBarItems`) is the
            part that gives way (`min-w-0`); the History / Files toggles never
            shrink. Clipped only as the fit's last resort. */}
        <div
          ref={actionBarLeftRef}
          data-testid="split-action-bar-left"
          className={`flex min-w-0 items-center gap-1${actionBarFit.squeezed ? ' overflow-x-clip' : ''}`}
        >
        {/* Issue #2261: while a split is maximized the label says which split is
            filling the row — the one line that explains why the other panes
            vanished. Issue #3514: the "n / 4 splits" count it showed otherwise
            is gone; the pressed layout icon says the same thing. */}
        {isMaximized ? (
          <span
            data-testid="split-count-label"
            className="min-w-0 text-xs text-muted-foreground tabular-nums mr-1 truncate"
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
          className="flex flex-shrink-0 items-center gap-0.5 rounded border border-border p-0.5"
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
            className="flex flex-shrink-0 items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
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
            className="flex flex-shrink-0 items-center justify-center h-7 w-7 rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted disabled:opacity-40 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
          >
            {isMaximized ? (
              <Minimize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            ) : (
              <Maximize2 className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
            )}
          </button>
        </Tooltip>

          {/* Issue #3590: the second row's items (the Verification chip), next
              to the layout ops. Issue #3592: the place the items' host is
              moved into (see `itemsHost`); the host is their 360px box. */}
          {actionBarItems && !actionBarFit.itemsFolded && (
            <span ref={attachItemsInline} hidden />
          )}

          {/* Issue #3592: the lone split's agent selector, Terminal / Chat,
              model, cost and note. In the left group, so the bar's fit counts
              it; `min-w-0` so the model / cost / note truncate first. */}
          {!sessionFolded && sessionSlot}
        </div>

        {/* Issue #3590: on a bar too narrow for them, the items wait behind
            this button, which never shrinks, in a panel out of every clip.
            Issue #3592: the lone split's session controls (selector, Terminal /
            Chat, note) wait there with them — parked, hidden but mounted, while
            the panel is closed. */}
        {(actionBarItems || sessionFolded) && actionBarFit.itemsFolded && (
          <ActionBarItemsOverflow
            label={t('terminal.actionBarMore')}
            parked={sessionFolded ? sessionSlot : null}
          >
            {actionBarItems ? <div ref={attachItemsFolded} style={{ display: 'contents' }} /> : null}
          </ActionBarItemsOverflow>
        )}
        {/* Issue #3592: the items themselves, wherever the host is (above). */}
        {actionBarItems && itemsHost ? createPortal(actionBarItems, itemsHost) : null}

        {/* Issue #1079: separator dividing layout ops (left) from panel toggles
            (right). `ml-auto` pushes the History / Files group to the far right. */}
        <div className="ml-auto h-4 w-px flex-shrink-0 bg-border" aria-hidden="true" />

        {/* Issue #3592: the lone split's search and "…". */}
        {singleSplit && (
          <div
            ref={setActionsSlotEl}
            data-testid="split-action-bar-pane-actions"
            className="flex flex-shrink-0 items-center gap-0.5"
          />
        )}

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
            {/* Issue #3590: dropped first when the bar is too narrow; the
                aria-label and the tooltip still name the toggle. */}
            {!actionBarFit.compactToggles && <span>{t('terminal.historyLabel')}</span>}
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
            {!actionBarFit.compactToggles && <span>{t('terminal.filesLabel')}</span>}
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
      <SplitHeaderSlotsProvider value={headerSlots}>
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
                  maximizeDisabled: splits.length <= MIN_SPLITS,
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
      </SplitHeaderSlotsProvider>
    </div>
  );
});

/** Gap between the "…" panel and the viewport edge, and below the button (px). */
const OVERFLOW_PANEL_MARGIN = 8;
const OVERFLOW_PANEL_GAP = 4;

/**
 * Issue #3590: the "…" panel's left edge — right-aligned with the button when
 * there is room, shifted right as far as needed so its left edge stays inside
 * the viewport, and pinned to the left margin when the panel is wider than the
 * viewport allows (its `max-w` then caps it). The same idea as the repository
 * tab popover's `clampPopoverLeft`, with the preference flipped: this button
 * sits at the right end of its group.
 *
 * Issue #3651: the left limit is the body's left edge (`regionLeft`, the
 * split container's), not the viewport's. With the sidebar open at 1024px the
 * panel is wider than the room left of "…", and a viewport-only clamp drew it
 * from x=8 — over the sidebar.
 *
 * @param buttonRight - The "…" button's viewport `right`
 * @param panelWidth - The panel's rendered width in px
 * @param viewportWidth - `window.innerWidth`
 * @param regionLeft - The body region's viewport `left` (0: the viewport)
 * @returns The `left` coordinate to render at
 * @internal Exported for unit tests.
 */
export function clampOverflowPanelLeft(
  buttonRight: number,
  panelWidth: number,
  viewportWidth: number,
  regionLeft = 0
): number {
  const minLeft = regionLeft + OVERFLOW_PANEL_MARGIN;
  const maxLeft = viewportWidth - OVERFLOW_PANEL_MARGIN - panelWidth;
  if (maxLeft <= minLeft) return minLeft;
  return Math.min(Math.max(buttonRight - panelWidth, minLeft), maxLeft);
}

/**
 * Issue #3651: the panel's `max-width` — the room from the body's left edge to
 * the viewport's right edge, minus a margin on each side. With `regionLeft` 0
 * it is the former `calc(100vw - 16px)`.
 *
 * @internal Exported for unit tests.
 */
export function overflowPanelMaxWidth(viewportWidth: number, regionLeft = 0): number {
  return Math.max(viewportWidth - regionLeft - 2 * OVERFLOW_PANEL_MARGIN, 0);
}

/**
 * Issue #3651: the "…" panel's box. `flex-wrap`: with the width measured from
 * the body (768px with a 480px sidebar leaves ~272px), the items — the chip
 * and the lone split's session controls — go onto further rows instead of
 * overrunning the box or each other. Each row item is capped at the box
 * (`max-w-full`, the chip's own root and the parked session slot) and shrinks
 * by truncating (`min-w-0`). Wrapping rather than scrolling: an `overflow`
 * would clip the chip's reason and the selector's menus, and keeps everything
 * in view without a scrollbar. A panel that fits stays one row, as before.
 */
const OVERFLOW_PANEL_CLASS =
  'fixed z-50 flex flex-wrap max-w-[calc(100vw-16px)] items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-lg';

/** Issue #3651: the body region the "…" panel stays inside. */
const OVERFLOW_PANEL_REGION_SELECTOR = '[data-testid="terminal-split-container"]';

/**
 * Issue #3590: the "…" button the action bar's items fold behind when the bar
 * is too narrow (`useSplitActionBarFit`). The panel is portalled to `<body>`
 * with `position: fixed` under the button, so neither the bar's clipped left
 * group nor the terminal pane's `overflow-hidden` (beside an open file panel)
 * can cut it. Its rendered width is measured before paint and its left edge
 * clamped into the viewport on both sides ({@link clampOverflowPanelLeft}).
 * Issue #3651: on the left, into the body — the split container's left edge,
 * so it never covers the sidebar (the viewport when there is no container).
 *
 * Focus follows the repository tab popover: opening moves focus to the
 * panel's first control, Escape closes and hands focus back to "…". A press
 * outside closes without moving focus — the press already put it where the
 * user wanted. A press inside any `[data-floating-layer]` (the chip's reason
 * popover) counts as inside.
 *
 * Issue #3592: `parked` is drawn after `children` while the panel is open,
 * and in a hidden box beside the button while it is closed — for a slot
 * another component portals into, which must exist in either state.
 *
 * Exported for tests (Issue #3591: its Esc beside the header tools' "…").
 */
export function ActionBarItemsOverflow({
  label,
  children,
  parked = null,
}: {
  label: string;
  children: ReactNode;
  parked?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxWidth: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!rect || !panel) return;
    const width = panel.getBoundingClientRect().width;
    const region = buttonRef.current?.closest(OVERFLOW_PANEL_REGION_SELECTOR);
    const regionLeft = Math.max(region?.getBoundingClientRect().left ?? 0, 0);
    const next = {
      top: rect.bottom + OVERFLOW_PANEL_GAP,
      left: clampOverflowPanelLeft(rect.right, width, window.innerWidth, regionLeft),
      maxWidth: overflowPanelMaxWidth(window.innerWidth, regionLeft),
    };
    setPosition((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.maxWidth === next.maxWidth
        ? prev
        : next
    );
  }, []);

  // Measure the rendered panel before paint (it renders hidden until placed),
  // then move focus to its first control.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place]);

  // Once per opening, after the panel is placed: a `visibility: hidden` panel
  // (the first, unmeasured render) cannot take focus.
  const placed = position !== null;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!placed || focusedRef.current) return;
    focusedRef.current = true;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      if (typeof target.closest === 'function' && target.closest('[data-floating-layer]')) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Issue #3592: an Escape a layer in the panel already handled (the
      // folded agent selector's menu closing itself) is not ours to act on.
      // Issue #3591: nor one the header tools' "…" list closed itself with.
      if (!isUnhandledEscape(event)) return;
      setOpen(false);
      buttonRef.current?.focus();
    };
    // The panel's content can change width (the chip's verdict) and the
    // button can move; re-measure on both, and on window resizes.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    if (observer && panelRef.current) observer.observe(panelRef.current);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <>
      <Tooltip content={label} placement="bottom" className="flex-shrink-0">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-testid="split-action-bar-items-overflow"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <Ellipsis className="w-4 h-4" aria-hidden="true" />
        </button>
      </Tooltip>
      {!open && parked ? <div hidden>{parked}</div> : null}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            data-testid="split-action-bar-items-panel"
            data-floating-layer="true"
            style={
              position
                ? { top: position.top, left: position.left, maxWidth: position.maxWidth }
                : { top: 0, left: 0, visibility: 'hidden' }
            }
            className={OVERFLOW_PANEL_CLASS}
          >
            {children}
            {parked}
          </div>,
          document.body
        )}
    </>
  );
}

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
