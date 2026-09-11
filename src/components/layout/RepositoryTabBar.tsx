/**
 * RepositoryTabBar — the header's repository strip (Issue #2374).
 *
 * ## What it is for
 *
 * On a laptop the sidebar is 220px of permanently-spent width, so users
 * collapse it — and then every repository/branch switch costs three actions:
 * open the sidebar, pick the branch, close it again. This strip is the
 * collapsed sidebar's navigation, folded into a 32px band above the header: one
 * tab per repository, click a tab for that repository's branches, click a
 * branch to go there.
 *
 * ## What it deliberately reuses
 *
 * Everything the sidebar already decides. The order comes from
 * `orderBranchGroups` over `SidebarContext.repositoryOrder` (so a drag in the
 * sidebar re-orders these tabs in the same commit), the grouping and branch
 * order from `useWorktreeList` with the sidebar's sort key/direction, the
 * hidden-repository filter from `filterWorktreesByVisibility`, and the rows
 * from `BranchListItem` itself — the popover renders the *same component* the
 * sidebar group renders, not a copy that looks like it.
 *
 * ## What it deliberately does not do
 *
 * **No hover-to-open.** A hover-revealed menu is permanently unreachable on a
 * touch device, and this app has one (see `AttentionBadge`'s docblock for the
 * same rule). Opening is a click, Enter or ArrowDown; closing is a click
 * elsewhere or Escape.
 *
 * **No drag reordering, no search box.** Reordering stays in the sidebar (this
 * strip follows it) and searching stays in the command palette (⌘K), so there
 * is exactly one place to do each.
 *
 * **No scrollbar.** The strip scrolls sideways once the tabs outgrow it, but
 * the classic always-visible scrollbar macOS draws while a mouse is connected
 * takes 15 of the band's 32px and squashes every tab into the top half (Issue
 * #2480). So the bar is hidden (`scrollbar-hide`) and the scrolled-out tabs
 * stay reachable three other ways — a trackpad swipe, a vertical mouse wheel
 * (turned sideways by `resolveWheelScrollLeftDelta`) and the "…" overflow
 * menu — while the tab of the worktree on screen is kept in view, since
 * nothing else says the strip is scrolled.
 *
 * @module components/layout/RepositoryTabBar
 */

'use client';

import React, {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import ReactDOM from 'react-dom';
import { usePathname } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { MoreHorizontal } from 'lucide-react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useWorktreeSelection } from '@/contexts/WorktreeSelectionContext';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import { useViewTransitionRouter } from '@/components/providers/ViewTransitionsProvider';
import { BranchListItem } from '@/components/sidebar/BranchListItem';
import { GroupIcon } from '@/components/ui/GroupIcon';
import { StatusDot } from '@/components/ui/StatusDot';
import { useWorktreeList } from '@/hooks/useWorktreeList';
import { toBranchItem } from '@/types/sidebar';
import {
  aggregateGroupStatus,
  buildHiddenRepositoryPathSet,
  countWaitingBranches,
  filterWorktreesByVisibility,
  generateRepositoryColor,
  orderBranchGroups,
} from '@/lib/sidebar-utils';
import type { BranchGroup } from '@/lib/sidebar-utils';
import { SIDEBAR_STATUS_CONFIG } from '@/config/status-colors';
import { Z_INDEX } from '@/config/z-index';

// ============================================================================
// Constants
// ============================================================================

/**
 * Band height in px at the `medium` display size. Scaled by the PC display-size
 * factor exactly like the sidebar width is (Issue #915), so shrinking the UI
 * shrinks the band instead of leaving a full-size strip above a small header.
 */
export const REPOSITORY_TAB_BAR_HEIGHT = 32;

/** Popover width in px (the Issue's 280–320 band). */
const POPOVER_WIDTH = 300;

/** Rows shown before the popover starts scrolling internally. */
const POPOVER_MAX_VISIBLE_ROWS = 10;

/**
 * Assumed row height in px, used only to turn `POPOVER_MAX_VISIBLE_ROWS` into a
 * max-height. `BranchListItem` is `py-3` around a two-line body, so a row that
 * also carries a next-action line is taller — the cap is "about ten rows", and
 * being approximate is fine because its whole job is to stop the popover from
 * running off the bottom of a 768px screen.
 */
const POPOVER_ROW_HEIGHT = 52;

/** Gap in px between the tab and the popover below it. */
const POPOVER_GAP = 4;

/** Minimum margin in px kept between the popover and the viewport edges. */
const VIEWPORT_MARGIN = 8;

/** Matches `/worktrees/<id>` (and anything under it) to find the active branch. */
const WORKTREE_ROUTE_PATTERN = /^\/worktrees\/([^/]+)/;

/** `WheelEvent.deltaMode` values, spelled out so the helper needs no DOM global. */
const DOM_DELTA_LINE = 1;
const DOM_DELTA_PAGE = 2;

/**
 * Pixels one wheel "line" is worth, for a browser that reports a mouse wheel in
 * lines (Firefox) rather than pixels. Only the magnitude matters: the usual
 * three lines a notch should move the strip about as far as the ~100px notch
 * a pixel-mode browser reports.
 */
const WHEEL_LINE_HEIGHT = 40;

// ============================================================================
// Types
// ============================================================================

/** Where a popover is anchored, in viewport coordinates. */
interface AnchorRect {
  left: number;
  right: number;
  bottom: number;
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Resolve the worktree the UI is currently showing.
 *
 * The pathname wins over `selectedWorktreeId` because it is correct on a cold
 * load of `/worktrees/<id>` — before anything has called `selectWorktree` — and
 * it is what the acceptance criterion ("the URL changes") actually observes.
 *
 * @param pathname - Current route
 * @param selectedWorktreeId - Context selection, used off worktree routes
 * @returns The worktree id to mark active, or null
 * @internal Exported for unit tests.
 */
export function resolveActiveWorktreeId(
  pathname: string,
  selectedWorktreeId: string | null
): string | null {
  const match = WORKTREE_ROUTE_PATTERN.exec(pathname);
  if (!match) return selectedWorktreeId;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    // A malformed percent-escape is still a usable id for comparison purposes.
    return match[1];
  }
}

/**
 * Clamp the popover's left edge so it stays inside the viewport.
 *
 * Prefers left-aligning with the tab, flips to right-aligning when that would
 * overflow, and clamps when neither side fits (a viewport narrower than the
 * popover itself).
 *
 * @param anchor - The tab's viewport rect
 * @param popoverWidth - Rendered popover width in px
 * @param viewportWidth - `window.innerWidth`
 * @returns The `left` coordinate to render at
 * @internal Exported for unit tests.
 */
export function clampPopoverLeft(
  anchor: AnchorRect,
  popoverWidth: number,
  viewportWidth: number
): number {
  const maxLeft = viewportWidth - VIEWPORT_MARGIN - popoverWidth;
  if (maxLeft <= VIEWPORT_MARGIN) return VIEWPORT_MARGIN;
  const preferred =
    anchor.left + popoverWidth > viewportWidth - VIEWPORT_MARGIN
      ? anchor.right - popoverWidth
      : anchor.left;
  return Math.min(Math.max(preferred, VIEWPORT_MARGIN), maxLeft);
}

/**
 * How far a wheel event should move the strip sideways, in px.
 *
 * The strip only scrolls horizontally and a mouse wheel only scrolls
 * vertically, so with the scrollbar hidden (Issue #2480) a mouse user would
 * have no way to scroll it at all. The vertical delta becomes a horizontal
 * one; what the browser already does sideways on its own is left to it
 * (returns 0):
 *
 * - a mostly-horizontal gesture — a trackpad swipe or a tilt wheel, which
 *   already scroll the strip natively; adding `deltaY` on top would skew it;
 * - Shift+wheel — the platform's own horizontal-scroll chord;
 * - Ctrl+wheel — how a trackpad pinch-zoom arrives.
 *
 * @param event - The wheel event's deltas, delta mode and modifier keys
 * @param pageWidth - The strip's visible width, what one `DOM_DELTA_PAGE` is worth
 * @returns px to add to `scrollLeft`, or 0 to leave the event to the browser
 * @internal Exported for unit tests.
 */
export function resolveWheelScrollLeftDelta(
  event: Pick<WheelEvent, 'deltaX' | 'deltaY' | 'deltaMode' | 'ctrlKey' | 'shiftKey'>,
  pageWidth: number
): number {
  if (event.ctrlKey || event.shiftKey) return 0;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return 0;
  if (event.deltaMode === DOM_DELTA_LINE) return event.deltaY * WHEEL_LINE_HEIGHT;
  if (event.deltaMode === DOM_DELTA_PAGE) return event.deltaY * pageWidth;
  return event.deltaY;
}

/**
 * Scroll a tab into the visible part of the strip. `nearest` on both axes
 * moves the strip only as far as needed and leaves the page itself alone.
 * Optional call because jsdom does not implement scrollIntoView, and the
 * shell's tests mount the strip on worktree routes.
 */
function revealTab(node: HTMLElement | undefined): void {
  node?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

// ============================================================================
// Component
// ============================================================================

/**
 * The repository strip. Renders nothing when there is no repository to show.
 *
 * Mounted by `AppShell` only when `shouldShowRepositoryTabBar` says so, and
 * only on desktop — the phone keeps its bottom tab bar and drawer.
 */
export const RepositoryTabBar = memo(function RepositoryTabBar() {
  const t = useTranslations('common');
  const pathname = usePathname();
  const router = useViewTransitionRouter();
  const { sortKey, sortDirection, repositoryOrder } = useSidebarContext();
  const { worktrees, repositories, selectedWorktreeId, selectWorktree } =
    useWorktreeSelection();
  // Issue #915: the band follows the PC display-size factor, like sidebar width.
  const { factor } = usePcDisplaySizeContext();

  // ---- the same list the sidebar builds, in the same order ----
  const hiddenRepositoryPaths = useMemo(
    () => buildHiddenRepositoryPathSet(repositories ?? []),
    [repositories]
  );
  const visibleWorktrees = useMemo(
    () => filterWorktreesByVisibility(worktrees ?? [], hiddenRepositoryPaths),
    [worktrees, hiddenRepositoryPaths]
  );
  const branchItems = useMemo(
    () => visibleWorktrees.map(toBranchItem),
    [visibleWorktrees]
  );
  // `viewMode` is pinned to 'grouped' rather than read from the context: the
  // strip IS the grouping, so a user who put the sidebar in flat mode still
  // needs one tab per repository.
  const { groupedItems } = useWorktreeList({
    items: branchItems,
    sortKey,
    sortDirection,
    viewMode: 'grouped',
  });
  const groups = useMemo(
    () => orderBranchGroups(groupedItems, repositoryOrder),
    [groupedItems, repositoryOrder]
  );

  const activeWorktreeId = resolveActiveWorktreeId(pathname, selectedWorktreeId);
  const activeRepositoryName = useMemo(
    () =>
      groups.find((group) => group.branches.some((b) => b.id === activeWorktreeId))
        ?.repositoryName ?? null,
    [groups, activeWorktreeId]
  );

  // ---- popover state ----
  const [openRepository, setOpenRepository] = useState<string | null>(null);
  const [anchorRect, setAnchorRect] = useState<AnchorRect | null>(null);
  const [isOverflowMenuOpen, setOverflowMenuOpen] = useState(false);

  const stripRef = useRef<HTMLDivElement>(null);
  const overflowButtonRef = useRef<HTMLButtonElement>(null);
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());
  const registerTab = useCallback((name: string, node: HTMLButtonElement | null) => {
    if (node) tabRefs.current.set(name, node);
    else tabRefs.current.delete(name);
  }, []);

  const closeAll = useCallback(() => {
    setOpenRepository(null);
    setAnchorRect(null);
    setOverflowMenuOpen(false);
  }, []);

  const openPopoverFor = useCallback((repositoryName: string) => {
    const node = tabRefs.current.get(repositoryName);
    if (!node) return;
    const rect = node.getBoundingClientRect();
    setAnchorRect({ left: rect.left, right: rect.right, bottom: rect.bottom });
    setOpenRepository(repositoryName);
    setOverflowMenuOpen(false);
  }, []);

  const togglePopoverFor = useCallback(
    (repositoryName: string) => {
      if (openRepository === repositoryName) {
        closeAll();
        return;
      }
      openPopoverFor(repositoryName);
    },
    [openRepository, closeAll, openPopoverFor]
  );

  // ---- overflow detection ----
  // The strip never wraps (`flex-nowrap`), so with enough repositories it
  // scrolls. A swipe or the wheel reaches everything, but with the scrollbar
  // hidden (Issue #2480) nothing says there is more, and neither can be tabbed
  // to, so an overflow menu appears next to it — and only then, because an
  // always-present "…" is chrome that earns nothing when three tabs fit.
  const [hasOverflow, setHasOverflow] = useState(false);
  const measureOverflow = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    setHasOverflow(strip.scrollWidth > strip.clientWidth + 1);
  }, []);

  useLayoutEffect(() => {
    measureOverflow();
  }, [measureOverflow, groups.length, factor]);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', measureOverflow);
    // A ResizeObserver catches the case the window event cannot: the sidebar
    // opening/closing changes the strip's width without resizing the window.
    const observer =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => measureOverflow())
        : null;
    if (observer && stripRef.current) observer.observe(stripRef.current);
    return () => {
      window.removeEventListener('resize', measureOverflow);
      observer?.disconnect();
    };
  }, [measureOverflow]);

  // ---- dismissal ----
  const isAnythingOpen = openRepository !== null || isOverflowMenuOpen;
  useEffect(() => {
    if (!isAnythingOpen) return;

    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      // A click on the strip itself is handled by the tab's own onClick (which
      // toggles); closing here first would make the second click re-open it.
      if (stripRef.current?.contains(target)) return;
      if (overflowButtonRef.current?.contains(target)) return;
      const inPanel = (target as Element).closest?.('[data-repository-tab-panel]');
      if (inPanel) return;
      closeAll();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      const focusTarget = openRepository
        ? tabRefs.current.get(openRepository)
        : overflowButtonRef.current;
      closeAll();
      focusTarget?.focus();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [isAnythingOpen, openRepository, closeAll]);

  // Close whatever is open when the route changes — the popover's whole purpose
  // is to be dismissed by picking a branch, and a portal outlives the click.
  useEffect(() => {
    closeAll();
  }, [pathname, closeAll]);

  // ---- keep the current repository's tab in view ----
  // With no scrollbar (Issue #2480) nothing says the strip is scrolled, so the
  // tab marked current must not sit scrolled out of sight. It is revealed on
  // first paint; after every navigation — keyed on `pathname`, not just the
  // repository, so moving between two branches of one repository brings its
  // tab back even after the user scrolled the strip away; and when the "…"
  // button appearing narrows the strip under it. Not on data refreshes: the
  // worktree poll re-renders every few seconds and would yank a strip the user
  // is scrolling. A layout effect, so the first paint already shows the tab.
  useLayoutEffect(() => {
    if (!activeRepositoryName) return;
    revealTab(tabRefs.current.get(activeRepositoryName));
  }, [activeRepositoryName, pathname, hasOverflow]);

  // ---- navigation ----
  const handleBranchClick = useCallback(
    (branchId: string) => {
      closeAll();
      void selectWorktree(branchId);
      router.push(`/worktrees/${branchId}`);
    },
    [closeAll, selectWorktree, router]
  );

  const handleOverflowSelect = useCallback(
    (repositoryName: string) => {
      const node = tabRefs.current.get(repositoryName);
      revealTab(node);
      openPopoverFor(repositoryName);
      node?.focus();
    },
    [openPopoverFor]
  );

  // ---- mouse wheel ----
  // React's wheel listener is passive, so this adds to the browser's own
  // scroll instead of replacing it. Nothing is lost by that: the strip cannot
  // scroll vertically, and the shell (`h-screen`) has nothing above it that
  // would take the vertical part of the wheel instead.
  const handleStripWheel = useCallback((event: React.WheelEvent<HTMLElement>) => {
    const strip = event.currentTarget;
    const delta = resolveWheelScrollLeftDelta(event, strip.clientWidth);
    if (delta !== 0) strip.scrollLeft += delta;
  }, []);

  if (groups.length === 0) return null;

  const bandHeight = Math.round(REPOSITORY_TAB_BAR_HEIGHT * factor);
  const openGroup = groups.find((g) => g.repositoryName === openRepository) ?? null;

  return (
    <div
      data-testid="repository-tab-bar"
      className="relative flex-shrink-0 flex items-stretch border-b border-border bg-surface"
      style={{ height: `${bandHeight}px` }}
    >
      <nav
        ref={stripRef}
        data-testid="repository-tab-strip"
        aria-label={t('nav.repositories')}
        onWheel={handleStripWheel}
        className="flex min-w-0 flex-1 flex-nowrap items-stretch overflow-x-auto overflow-y-hidden scrollbar-hide"
      >
        {groups.map((group) => (
          <RepositoryTab
            key={group.repositoryName}
            group={group}
            isActive={group.repositoryName === activeRepositoryName}
            isOpen={group.repositoryName === openRepository}
            registerTab={registerTab}
            onToggle={togglePopoverFor}
          />
        ))}
      </nav>

      {hasOverflow && (
        <button
          ref={overflowButtonRef}
          type="button"
          data-testid="repository-tab-overflow"
          aria-haspopup="menu"
          aria-expanded={isOverflowMenuOpen}
          aria-label={t('nav.more')}
          title={t('nav.more')}
          onClick={() => {
            setOpenRepository(null);
            setAnchorRect(null);
            setOverflowMenuOpen((open) => !open);
          }}
          className="flex-shrink-0 flex items-center border-l border-border px-2
            text-muted-foreground transition-colors hover:bg-surface-2 hover:text-foreground
            focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <MoreHorizontal size={16} strokeWidth={2} aria-hidden="true" />
        </button>
      )}

      {openGroup && anchorRect && (
        <BranchPopover
          group={openGroup}
          anchor={anchorRect}
          factor={factor}
          activeWorktreeId={activeWorktreeId}
          onBranchClick={handleBranchClick}
        />
      )}

      {isOverflowMenuOpen && (
        <OverflowMenu
          groups={groups}
          anchorRef={overflowButtonRef}
          activeRepositoryName={activeRepositoryName}
          onSelect={handleOverflowSelect}
        />
      )}
    </div>
  );
});

// ============================================================================
// RepositoryTab
// ============================================================================

/**
 * One repository's tab: folder icon in the repository colour, name, aggregated
 * status dot and — only
 * when something is blocked — the count of branches waiting for the user.
 */
const RepositoryTab = memo(function RepositoryTab({
  group,
  isActive,
  isOpen,
  registerTab,
  onToggle,
}: {
  group: BranchGroup;
  isActive: boolean;
  isOpen: boolean;
  registerTab: (name: string, node: HTMLButtonElement | null) => void;
  onToggle: (repositoryName: string) => void;
}) {
  const t = useTranslations('common');
  const status = aggregateGroupStatus(group.branches);
  const waitingCount = countWaitingBranches(group.branches);
  // The status vocabulary is `SIDEBAR_STATUS_CONFIG`'s, so the tab and the
  // sidebar say the same word for the same state (Issue #1304 keeps these as
  // dictionary keys because the config is module scope, where t() cannot run).
  const statusLabel = t(SIDEBAR_STATUS_CONFIG[status].labelKey);

  return (
    <button
      ref={(node) => registerTab(group.repositoryName, node)}
      type="button"
      data-testid="repository-tab"
      data-repository={group.repositoryName}
      aria-haspopup="menu"
      aria-expanded={isOpen}
      aria-current={isActive ? 'true' : undefined}
      // The full name, because the visible one is middle-truncated by `truncate`
      // as soon as two repositories share a long prefix.
      title={`${group.repositoryName} — ${statusLabel}`}
      onClick={() => onToggle(group.repositoryName)}
      onKeyDown={(event) => {
        // Enter/Space already arrive as a click on a <button>; ArrowDown is the
        // extra affordance, so the strip behaves like the menubar it looks like.
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          if (!isOpen) onToggle(group.repositoryName);
        }
      }}
      className={`
        group/tab flex-shrink-0 flex max-w-[14rem] items-center gap-1.5 px-2.5
        border-b-2 text-xs font-medium transition-colors
        focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring
        ${
          isActive
            ? 'border-accent-500 bg-surface-2 text-foreground'
            : 'border-transparent text-muted-foreground hover:bg-surface-2 hover:text-foreground'
        }
      `}
    >
      <GroupIcon
        className="h-3.5 w-3.5"
        color={generateRepositoryColor(group.repositoryName)}
      />
      <span className="min-w-0 truncate">{group.repositoryName}</span>
      <StatusDot
        status={status}
        size="sm"
        label={statusLabel}
        data-testid="repository-tab-status"
      />
      {waitingCount > 0 && (
        <span
          data-testid="repository-tab-attention-count"
          aria-label={t('attention.badgeLabel', { count: waitingCount })}
          className="flex-shrink-0 rounded-full bg-warning-subtle px-1.5
            text-[10px] font-semibold leading-4 tabular-nums text-warning-foreground"
        >
          {waitingCount}
        </span>
      )}
    </button>
  );
});

// ============================================================================
// BranchPopover
// ============================================================================

/**
 * The branch list for one repository, portalled to `document.body` so the
 * strip's `overflow-x-auto` cannot clip it.
 *
 * Rows are `BranchListItem` — the sidebar's own row component — so the status
 * dot, next action, "ready for work" badge and unread dot are the same markup
 * the sidebar group shows, not a second rendering that has to be kept in step.
 */
function BranchPopover({
  group,
  anchor,
  factor,
  activeWorktreeId,
  onBranchClick,
}: {
  group: BranchGroup;
  anchor: AnchorRect;
  factor: number;
  activeWorktreeId: string | null;
  onBranchClick: (branchId: string) => void;
}) {
  const t = useTranslations('common');
  const panelRef = useRef<HTMLDivElement>(null);

  // Move focus into the list on open so ArrowDown from the tab lands somewhere
  // useful, and so Escape has something to return focus from.
  useEffect(() => {
    const first = panelRef.current?.querySelector<HTMLElement>('button');
    first?.focus();
  }, [group.repositoryName]);

  if (typeof document === 'undefined') return null;

  const width = Math.round(POPOVER_WIDTH * factor);
  const viewportWidth = typeof window === 'undefined' ? width : window.innerWidth;

  return ReactDOM.createPortal(
    <div
      ref={panelRef}
      data-repository-tab-panel=""
      data-testid="repository-tab-popover"
      data-repository={group.repositoryName}
      role="menu"
      aria-label={t('sidebar.branchNavigation')}
      className="fixed rounded-md border border-sidebar-border bg-sidebar
        text-sidebar-foreground shadow-lg"
      style={{
        top: anchor.bottom + POPOVER_GAP,
        left: clampPopoverLeft(anchor, width, viewportWidth),
        width,
        // Above Modal so a popover opened while a dialog is up is not clipped,
        // matching what the Radix popovers in this app use.
        zIndex: Z_INDEX.POPOVER,
      }}
    >
      <div
        data-testid="repository-tab-popover-list"
        className="overflow-y-auto overflow-x-hidden py-1"
        style={{
          maxHeight: `${Math.round(
            POPOVER_MAX_VISIBLE_ROWS * POPOVER_ROW_HEIGHT * factor
          )}px`,
        }}
      >
        {group.branches.length === 0 ? (
          <p className="px-4 py-6 text-center text-sm text-sidebar-muted">
            {t('sidebar.noBranchesAvailable')}
          </p>
        ) : (
          group.branches.map((branch) => (
            <BranchListItem
              key={branch.id}
              branch={branch}
              isSelected={branch.id === activeWorktreeId}
              onClick={() => onBranchClick(branch.id)}
              showRepositoryName={false}
            />
          ))
        )}
      </div>
    </div>,
    document.body
  );
}

// ============================================================================
// OverflowMenu
// ============================================================================

/**
 * Every repository as a flat list, for the ones scrolled out of the strip.
 *
 * Selecting one scrolls its tab into view and opens that tab's popover, rather
 * than nesting a branch list inside this menu — one popover on screen at a time
 * keeps the dismissal rules (Escape, outside click) unambiguous.
 */
function OverflowMenu({
  groups,
  anchorRef,
  activeRepositoryName,
  onSelect,
}: {
  groups: BranchGroup[];
  anchorRef: { current: HTMLButtonElement | null };
  activeRepositoryName: string | null;
  onSelect: (repositoryName: string) => void;
}) {
  const t = useTranslations('common');
  const anchor = anchorRef.current?.getBoundingClientRect();

  if (typeof document === 'undefined' || !anchor) return null;

  const width = POPOVER_WIDTH;
  const viewportWidth = typeof window === 'undefined' ? width : window.innerWidth;

  return ReactDOM.createPortal(
    <div
      data-repository-tab-panel=""
      data-testid="repository-tab-overflow-menu"
      role="menu"
      aria-label={t('nav.repositories')}
      className="fixed rounded-md border border-sidebar-border bg-sidebar
        text-sidebar-foreground shadow-lg"
      style={{
        top: anchor.bottom + POPOVER_GAP,
        left: clampPopoverLeft(
          { left: anchor.left, right: anchor.right, bottom: anchor.bottom },
          width,
          viewportWidth
        ),
        width,
        maxHeight: `${POPOVER_MAX_VISIBLE_ROWS * POPOVER_ROW_HEIGHT}px`,
        zIndex: Z_INDEX.POPOVER,
      }}
    >
      <div className="overflow-y-auto py-1" style={{ maxHeight: 'inherit' }}>
        {groups.map((group) => {
          const status = aggregateGroupStatus(group.branches);
          return (
            <button
              key={group.repositoryName}
              type="button"
              role="menuitem"
              data-testid="repository-tab-overflow-item"
              data-repository={group.repositoryName}
              aria-current={
                group.repositoryName === activeRepositoryName ? 'true' : undefined
              }
              onClick={() => onSelect(group.repositoryName)}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-sm
                transition-colors hover:bg-sidebar-hover
                focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
            >
              <GroupIcon
                className="h-3.5 w-3.5"
                color={generateRepositoryColor(group.repositoryName)}
              />
              <span className="min-w-0 flex-1 truncate">{group.repositoryName}</span>
              <StatusDot
                status={status}
                size="sm"
                label={t(SIDEBAR_STATUS_CONFIG[status].labelKey)}
              />
              <span className="tabular-nums text-xs text-sidebar-muted">
                {group.branches.length}
              </span>
            </button>
          );
        })}
      </div>
    </div>,
    document.body
  );
}
