
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
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { useTranslations } from 'next-intl';
import type { AgentInstance, CLIToolType } from '@/lib/cli-tools/types';
import type { ShowToast } from '@/types/markdown-editor';
import {
  MAX_SPLITS,
  MIN_SPLITS,
  isGridLayout,
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
} from '@/hooks/useFilePanelState';
import { useSplitActionBarFit } from '@/hooks/useDesktopHeaderFit';
import { SplitHeaderSlotsProvider, type SplitHeaderSlots } from './SplitPaneHeaderControls';
import { ActionBarItemsOverflow } from './terminal-split-container/ActionBarItemsOverflow';
import { PaneResizerWrapper } from './terminal-split-container/PaneResizerWrapper';
import { gridColumnOf, gridRowOf, gridTemplateStyle } from './terminal-split-container/grid-layout';
import { ActionBarSessionSlot } from './terminal-split-container/ActionBarSessionSlot';
import { SplitLayoutOps } from './terminal-split-container/SplitLayoutOps';
import { TerminalPanelVisibilityToggles } from './terminal-split-container/TerminalPanelVisibilityToggles';
import { useSplitFocusAndPlacement } from './terminal-split-container/useSplitFocusAndPlacement';
import { useSplitResizeHandlers } from './terminal-split-container/useSplitResizeHandlers';
import { useActionBarItemsHost } from './terminal-split-container/useActionBarItemsHost';
import { usePerSplitHandlers } from './terminal-split-container/usePerSplitHandlers';

export {
  ActionBarItemsOverflow,
  clampOverflowPanelLeft,
  overflowPanelMaxWidth,
} from './terminal-split-container/ActionBarItemsOverflow';
export type { InstancePlacementRequest, SelectedSplit } from './terminal-split-container/types';
import type { InstancePlacementRequest, SelectedSplit } from './terminal-split-container/types';


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

  useSplitFocusAndPlacement({
    splits,
    focusedSplitIndex,
    setFocusedSplitIndex,
    setSplitInstance,
    openInstanceInNewSplit,
    instances,
    containerRef,
    onFocusedSplitChange,
    onActiveInstanceChange,
    headerInstanceSelection,
    instancePlacementRequest,
    onInstancePlacementApplied,
    onSplitCountChange,
    onSelectedSplitChange,
  });

  const {
    handleResize,
    gridColumnFr,
    gridRowFr,
    handleGridColumnResize,
    handleGridRowResize,
  } = useSplitResizeHandlers({
    containerRef,
    widths,
    rowHeights,
    setSplitWidth,
    setRowHeights,
  });

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
  const { itemsHost, attachItemsInline, attachItemsFolded } = useActionBarItemsHost();
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
  // Issue #3651: folded, the slot is a named group with `data-folded`, so the
  // split's row of controls portalled into it (`split-bar-session-N`) wraps
  // onto further lines inside the narrow panel — the toggle, the note with its
  // time, End and the name stay apart and in reach. Inline on the bar the slot
  // is unchanged, and the row stays one line.
  const sessionSlot = singleSplit ? (
    <ActionBarSessionSlot slotRef={setSessionSlotEl} folded={sessionFolded} />
  ) : null;
  const headerSlots = useMemo<SplitHeaderSlots | null>(
    () =>
      singleSplit && sessionSlotEl && actionsSlotEl
        ? { session: sessionSlotEl, actions: actionsSlotEl }
        : null,
    [singleSplit, sessionSlotEl, actionsSlotEl],
  );

  const { focusHandlers, instanceChangeHandlers, maximizeHandlers, dropHandlers } =
    usePerSplitHandlers({
      splits,
      instanceById,
      setFocusedSplitIndex,
      setSplitInstance,
      toggleMaximize,
      showToast,
      onActiveInstanceChange,
    });


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
        <SplitLayoutOps
          splitCount={splits.length}
          isResizing={isResizing}
          maxSelectableSplits={maxSelectableSplits}
          setSplitCount={setSplitCount}
          canEqualize={canEqualize}
          handleEqualizeWidths={handleEqualizeWidths}
          isMaximized={isMaximized}
          maximizedIndex={maximizedIndex}
          canMaximize={canMaximize}
          handleToggleMaximize={handleToggleMaximize}
        />


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

        <TerminalPanelVisibilityToggles
          historyVisible={historyVisible}
          toggleHistory={toggleHistory}
          historySlotIds={historySlotIds}
          filesVisible={filesVisible}
          filesUnavailable={filesUnavailable}
          toggleFilePanel={toggleFilePanel}
          openFileCount={openFileCount}
          compactToggles={actionBarFit.compactToggles}
        />
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
        style={isGrid ? gridTemplateStyle(isMaximized, gridColumnFr, gridRowFr) : undefined}
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


export default TerminalSplitContainer;
