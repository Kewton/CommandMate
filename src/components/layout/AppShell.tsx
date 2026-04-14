/**
 * AppShell Component
 *
 * Main layout component that integrates sidebar, header, and main content.
 * Handles responsive layout for desktop and mobile.
 *
 * Issue #600: UX refresh - useLayoutConfig flags drive rendering.
 * AppShell only renders based on flags; layout logic is in useLayoutConfig().
 */

'use client';

import React, { memo, useCallback, type ReactNode } from 'react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { useLayoutConfig } from '@/hooks/useLayoutConfig';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { GlobalMobileNav } from '@/components/mobile/GlobalMobileNav';
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
  const { isOpen, isMobileDrawerOpen, closeMobileDrawer, width, setWidth } = useSidebarContext();
  const isMobile = useIsMobile();
  const { showSidebar, showGlobalNav } = useLayoutConfig();

  const handleWidthChange = useCallback((newWidth: number) => {
    setWidth(Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, newWidth)));
  }, [setWidth]);

  // Mobile layout with drawer
  if (isMobile) {
    return (
      <div data-testid="app-shell" className="h-screen flex flex-col">
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
        <main className={`flex-1 min-h-0 overflow-hidden ${showGlobalNav ? 'pb-14' : ''}`} role="main">
          {children}
        </main>

        {/* Global mobile nav (bottom tab bar) */}
        {showGlobalNav && <GlobalMobileNav />}
      </div>
    );
  }

  // Desktop layout with fixed sidebar and padding-based content shift
  // Issue #112: Using transform for better performance (GPU-accelerated)
  return (
    <div data-testid="app-shell" className="h-screen flex flex-col">
      {/* Header with 5-screen navigation */}
      {showGlobalNav && <Header />}

      <div className="flex flex-1 min-h-0">
        {/* Desktop sidebar - fixed position with transform animation (Issue #112) */}
        {/* Width is dynamic (drag-resizable); stored in SidebarContext + localStorage */}
        {showSidebar && (
          <aside
            data-testid="sidebar-container"
            className={`
              fixed left-0 top-0 h-full
              border-r border-gray-200 dark:border-gray-600
              ${SIDEBAR_TRANSITION}
              ${isOpen ? 'translate-x-0' : '-translate-x-full'}
            `}
            style={{ width: `${width}px`, zIndex: Z_INDEX.SIDEBAR }}
            role="complementary"
            aria-hidden={!isOpen}
          >
            <Sidebar />
            <ResizeHandle currentWidth={width} onWidthChange={handleWidthChange} />
          </aside>
        )}

        {/* Main content - paddingLeft matches sidebar width */}
        <main
          className="flex-1 min-w-0 h-full overflow-hidden transition-[padding] duration-300 ease-out"
          style={{ paddingLeft: showSidebar && isOpen ? `${width}px` : 0 }}
          role="main"
        >
          {children}
        </main>
      </div>
    </div>
  );
});

// ============================================================================
// ResizeHandle
// ============================================================================

/**
 * Thin drag handle on the right edge of the sidebar for resizing.
 * Emits the new absolute width (not a delta) via onWidthChange.
 */
function ResizeHandle({
  currentWidth,
  onWidthChange,
}: {
  currentWidth: number;
  onWidthChange: (width: number) => void;
}) {
  const handleMouseDown = (e: React.MouseEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startWidth = currentWidth;

    const handleMouseMove = (moveEvent: MouseEvent) => {
      onWidthChange(startWidth + (moveEvent.clientX - startX));
    };

    const handleMouseUp = () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
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
      className="absolute top-0 right-0 w-1 h-full cursor-col-resize hover:bg-cyan-500/40 transition-colors"
    />
  );
}
