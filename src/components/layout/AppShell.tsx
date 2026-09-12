/**
 * AppShell Component
 *
 * Main layout component that integrates sidebar, header, and main content.
 * Handles responsive layout for desktop and mobile.
 *
 * Issue #600: UX refresh - useLayoutConfig flags drive rendering.
 * AppShell only renders based on flags; layout logic is in useLayoutConfig().
 *
 * Issue #2501: the mobile branch draws the connection banner. It has to live
 * here because the mobile branch renders no `Header`, which is where the
 * desktop `ConnectionStatusIndicator` sits.
 *
 * Issue #2374: the desktop branch also draws the repository tab strip, above
 * the header. It lives at this level rather than inside `Header` because
 * `/worktrees/*` hides the header entirely (`showGlobalNav: false`) and that is
 * the screen users switch branches from most.
 */

'use client';

import React, { memo, useCallback, useRef, type ReactNode } from 'react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLayoutConfig } from '@/hooks/useLayoutConfig';
import { usePcDisplaySizeContext } from '@/contexts/PcDisplaySizeContext';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { RepositoryTabBar, REPOSITORY_TAB_BAR_HEIGHT } from './RepositoryTabBar';
import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';
import { MobileConnectionBanner } from '@/components/mobile/MobileConnectionBanner';
import { CommandPalette } from '@/components/common/CommandPalette';
import { KeyboardShortcutsOverlay } from '@/components/common/KeyboardShortcutsOverlay';
import { VersionMismatchBanner } from './VersionMismatchBanner';
import {
  shouldShowRepositoryTabBar,
  DEFAULT_REPO_TAB_BAR_MODE,
} from '@/lib/sidebar-utils';
import { Z_INDEX } from '@/config/z-index';

// ============================================================================
// Constants
// ============================================================================

/**
 * Common sidebar transition classes for GPU-accelerated animations.
 * Used by both mobile drawer and desktop sidebar (Issue #112).
 */
const SIDEBAR_TRANSITION = 'transform transition-transform duration-300 ease-out';

/** Minimum sidebar width when drag-resizing */
const MIN_SIDEBAR_WIDTH = 160;

/** Maximum sidebar width when drag-resizing */
const MAX_SIDEBAR_WIDTH = 480;

/** Header height in px — the `h-16` on Header's inner row (Issue #1070). */
const HEADER_HEIGHT = 64;

// ============================================================================
// Types
// ============================================================================

/** Props for AppShell */
export interface AppShellProps {
  /** Main content to display */
  children: ReactNode;
}

// ============================================================================
// Component
// ============================================================================

/**
 * AppShell layout component
 *
 * Provides the main application layout with sidebar and content area.
 * Handles responsive behavior for desktop and mobile.
 * Uses useLayoutConfig() flags for conditional rendering [DR1-003].
 *
 * @example
 * ```tsx
 * <SidebarProvider>
 *   <WorktreeSelectionProvider>
 *     <AppShell>
 *       <WorktreeDetail />
 *     </AppShell>
 *   </WorktreeSelectionProvider>
 * </SidebarProvider>
 * ```
 */
export const AppShell = memo(function AppShell({ children }: AppShellProps) {
  const {
    isOpen,
    isMobileDrawerOpen,
    closeMobileDrawer,
    width,
    setWidth,
    repoTabBarMode,
  } = useSidebarContext();
  const isMobile = useIsMobile();
  const { showSidebar, showGlobalNav } = useLayoutConfig();
  // Issue #915: scale fixed-px sidebar width by the PC display-size factor.
  const { factor } = usePcDisplaySizeContext();

  // Stored width is kept in medium-base px; the displayed width (and clamps) are
  // scaled by the current size factor so the sidebar roughly follows the UI scale.
  const minWidth = Math.round(MIN_SIDEBAR_WIDTH * factor);
  const maxWidth = Math.round(MAX_SIDEBAR_WIDTH * factor);
  const displayWidth = Math.round(
    Math.min(maxWidth, Math.max(minWidth, width * factor))
  );

  // Issue #2374: the repository strip. Desktop only, and by default only while
  // the sidebar is collapsed — it is that sidebar's navigation, not a second
  // copy of it. Drawn at AppShell level rather than inside Header so it is also
  // there on /worktrees/*, where `showGlobalNav` removes the header entirely
  // (useLayoutConfig) — which is exactly the screen users switch branches from.
  // `?? DEFAULT_REPO_TAB_BAR_MODE` keeps the shell renderable against a partial
  // SidebarContext stub.
  const showRepositoryTabBar = shouldShowRepositoryTabBar(
    repoTabBarMode ?? DEFAULT_REPO_TAB_BAR_MODE,
    isOpen
  );

  // The desktop sidebar is `position: fixed`, so it does not participate in the
  // flex column the strip is added to — its `top-16 / top-0` classes would put
  // it underneath the band. When (and only when) the band is up, an inline
  // offset overrides those classes; with the band down nothing is written and
  // the classes stand exactly as they did, which is what #1070's assertions
  // pin.
  const bandHeight = Math.round(REPOSITORY_TAB_BAR_HEIGHT * factor);
  const sidebarTop = bandHeight + (showGlobalNav ? HEADER_HEIGHT : 0);
  const sidebarOffsetStyle = showRepositoryTabBar
    ? { top: `${sidebarTop}px`, height: `calc(100vh - ${sidebarTop}px)` }
    : {};

  // Refs for direct DOM manipulation during drag (avoids React re-render lag)
  const sidebarRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLElement>(null);

  // Called only on mouseup — persists final width to React state + localStorage.
  // newWidth is in display space; convert back to medium-base before storing so
  // it survives size changes without compounding the factor.
  const handleWidthChange = useCallback((newWidth: number) => {
    setWidth(Math.round(newWidth / factor)); // already clamped by ResizeHandle
  }, [setWidth, factor]);

  // Mobile layout with drawer
  if (isMobile) {
    return (
      <div data-testid="app-shell" className="h-screen flex flex-col">
        {/* Connection status (Issue #2501). First in the column, and in flow
            rather than floating, so its height comes out of <main> and it can
            never cover the composer or the bottom tab bar (cf. #2271). Renders
            nothing while connected. */}
        <MobileConnectionBanner />

        {/* Mobile drawer overlay */}
        {isMobileDrawerOpen && (
          <div
            data-testid="drawer-overlay"
            className="fixed inset-0 bg-black/50 z-40"
            onClick={closeMobileDrawer}
            aria-hidden="true"
          />
        )}

        {/* Mobile drawer - uses z-50 (above overlay z-40) for proper stacking */}
        {showSidebar && (
          <aside
            data-testid="sidebar-container"
            className={`
              fixed left-0 top-0 h-full w-72 z-50
              ${SIDEBAR_TRANSITION}
              ${isMobileDrawerOpen ? 'translate-x-0' : '-translate-x-full'}
            `}
            role="complementary"
          >
            <Sidebar />
          </aside>
        )}

        {/* Main content */}
        <main
          className={`flex-1 min-h-0 overflow-hidden ${showGlobalNav ? 'pb-14' : ''}`}
          role="main"
          data-view-transition="content"
        >
          {children}
        </main>

        {/* Global mobile nav (bottom tab bar) */}
        {showGlobalNav && <GlobalMobileNav />}

        {/* Global command palette (⌘K / Ctrl+K) - single instance (Issue #1053) */}
        <CommandPalette />
        {/* Global keyboard-shortcuts help overlay (?) - single instance (Issue #1130) */}
        <KeyboardShortcutsOverlay />
        {/* Version-drift reload nudge (#1338/#1356) - app-wide, single instance. */}
        <VersionMismatchBanner />
      </div>
    );
  }

  // Desktop layout with fixed sidebar and padding-based content shift
  // Issue #112: Using transform for better performance (GPU-accelerated)
  return (
    <div data-testid="app-shell" className="h-screen flex flex-col">
      {/* Repository tab strip, above the header (Issue #2374) */}
      {showRepositoryTabBar && <RepositoryTabBar />}

      {/* Header with 5-screen navigation */}
      {showGlobalNav && <Header />}

      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar - fixed position with transform animation (Issue #112) */}
        {/* Width is dynamic (drag-resizable); stored in SidebarContext + localStorage */}
        {showSidebar && (
          <aside
            ref={sidebarRef}
            data-testid="sidebar-container"
            className={`
              fixed left-0
              ${showGlobalNav ? 'top-16 h-[calc(100vh-4rem)]' : 'top-0 h-full'}
              border-r border-border
              ${SIDEBAR_TRANSITION}
              ${isOpen ? 'translate-x-0' : '-translate-x-full'}
            `}
            style={{
              width: `${displayWidth}px`,
              zIndex: Z_INDEX.SIDEBAR,
              ...sidebarOffsetStyle,
            }}
            role="complementary"
            aria-hidden={!isOpen}
          >
            <Sidebar />
            <ResizeHandle
              currentWidth={displayWidth}
              minWidth={minWidth}
              maxWidth={maxWidth}
              sidebarRef={sidebarRef}
              mainRef={mainRef}
              onWidthChange={handleWidthChange}
            />
          </aside>
        )}

        {/* Main content - paddingLeft matches sidebar width */}
        <main
          ref={mainRef}
          className="flex-1 min-w-0 h-full overflow-hidden transition-[padding] duration-300 ease-out"
          style={{ paddingLeft: showSidebar && isOpen ? `${displayWidth}px` : 0 }}
          role="main"
          data-view-transition="content"
        >
          {children}
        </main>
      </div>

      {/* Global command palette (⌘K / Ctrl+K) - single instance (Issue #1053) */}
      <CommandPalette />
      {/* Global keyboard-shortcuts help overlay (?) - single instance (Issue #1130) */}
      <KeyboardShortcutsOverlay />
      {/* Version-drift reload nudge (#1338/#1356) - app-wide, single instance. */}
      <VersionMismatchBanner />
    </div>
  );
});

// ============================================================================
// ResizeHandle
// ============================================================================

/**
 * Thin drag handle on the right edge of the sidebar for resizing.
 *
 * During drag: updates sidebar width and main paddingLeft directly via DOM refs
 * (no React state changes) for zero-lag response.
 * On mouseup: calls onWidthChange once to persist the final value to React state.
 */
function ResizeHandle({
  currentWidth,
  minWidth,
  maxWidth,
  sidebarRef,
  mainRef,
  onWidthChange,
}: {
  currentWidth: number;
  minWidth: number;
  maxWidth: number;
  sidebarRef: { current: HTMLElement | null };
  mainRef: { current: HTMLElement | null };
  onWidthChange: (width: number) => void;
}) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = currentWidth;
    let finalWidth = startWidth;

    // Disable padding transition while dragging to prevent animation lag
    if (mainRef.current) {
      mainRef.current.style.transition = 'none';
    }

    const handleMouseMove = (moveEvent: MouseEvent) => {
      const raw = startWidth + (moveEvent.clientX - startX);
      finalWidth = Math.max(minWidth, Math.min(maxWidth, raw));
      // Direct DOM writes — bypasses React state for lag-free tracking
      if (sidebarRef.current) {
        sidebarRef.current.style.width = `${finalWidth}px`;
      }
      if (mainRef.current) {
        mainRef.current.style.paddingLeft = `${finalWidth}px`;
      }
    };

    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      // Restore transition so sidebar toggle animates smoothly again
      if (mainRef.current) {
        mainRef.current.style.transition = '';
      }
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      // Commit final width to React state (triggers localStorage persist)
      onWidthChange(finalWidth);
    };

    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
  };

  return (
    <div
      data-testid="sidebar-resize-handle"
      aria-hidden="true"
      onMouseDown={handleMouseDown}
      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-accent-500/40 transition-colors"
    />
  );
}
