/**
 * AppShell Component
 *
 * Main layout component that integrates sidebar and main content.
 * Handles responsive layout for desktop and mobile.
 */

'use client';

import React, { memo, type ReactNode } from 'react';
import { useSidebarContext } from '@/contexts/SidebarContext';
import { useIsMobile } from '@/hooks/useIsMobile';
import { Sidebar } from './Sidebar';
import { Z_INDEX } from '@/config/z-index';

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
  const { isOpen, isMobileDrawerOpen, closeMobileDrawer } = useSidebarContext();
  const isMobile = useIsMobile();

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

        {/* Mobile drawer */}
        <aside
          data-testid="sidebar-container"
          className={`
            fixed left-0 top-0 h-full w-72 z-50
            transform transition-transform duration-300 ease-out
            ${isMobileDrawerOpen ? 'translate-x-0' : '-translate-x-full'}
          `}
          role="complementary"
        >
          <Sidebar />
        </aside>

        {/* Main content */}
        <main className="flex-1 min-h-0 overflow-hidden" role="main">
          {children}
        </main>
      </div>
    );
  }

  // Desktop layout with fixed sidebar and padding-based content shift
  // Issue #112: Using transform for better performance (GPU-accelerated)
  return (
    <div data-testid="app-shell" className="h-screen flex">
      {/* Sidebar container - fixed position with transform animation */}
      <aside
        data-testid="sidebar-container"
        className={`
          fixed left-0 top-0 h-full w-72
          transform transition-transform duration-300 ease-out
          ${isOpen ? 'translate-x-0' : '-translate-x-full'}
        `}
        style={{ zIndex: Z_INDEX.SIDEBAR }}
        role="complementary"
        aria-hidden={!isOpen}
      >
        <Sidebar />
      </aside>

      {/* Main content - padding adjusts based on sidebar state */}
      <main
        className={`
          flex-1 min-w-0 h-full overflow-hidden
          transition-[padding] duration-300 ease-out
          ${isOpen ? 'md:pl-72' : 'md:pl-0'}
        `}
        role="main"
      >
        {children}
      </main>
    </div>
  );
});
