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

  // Desktop layout with side-by-side panels
  return (
    <div data-testid="app-shell" className="h-screen flex">
      {/* Sidebar container */}
      <aside
        data-testid="sidebar-container"
        className={`
          flex-shrink-0 h-full
          transition-all duration-300 ease-out
          ${isOpen ? 'w-72' : 'w-0'}
          overflow-hidden
        `}
        role="complementary"
      >
        <div className="w-72 h-full">
          <Sidebar />
        </div>
      </aside>

      {/* Main content */}
      <main
        className={`
          flex-1 min-w-0 h-full overflow-hidden
          transition-all duration-300 ease-out
          ${isOpen ? 'ml-0' : 'ml-0'}
        `}
        role="main"
      >
        {children}
      </main>
    </div>
  );
});
