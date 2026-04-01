/**
 * useLayoutConfig - Layout configuration hook based on pathname.
 *
 * Issue #600: UX refresh - Conditional Layout pattern [DR1-003]
 * Resolves pathname to layout flags so AppShell only handles rendering.
 */

'use client';

import { usePathname } from 'next/navigation';

/**
 * Layout configuration flags for AppShell rendering.
 */
export interface LayoutConfig {
  /** Whether the sidebar should be shown */
  showSidebar: boolean;
  /** Whether the global navigation (Header/GlobalMobileNav) should be shown */
  showGlobalNav: boolean;
  /** Whether local navigation (MobileTabBar within Detail) should be shown */
  showLocalNav: boolean;
  /** Whether sidebar should auto-collapse on mount (e.g., Sessions page) */
  autoCollapseSidebar: boolean;
}

/**
 * Default layout configuration.
 */
export const DEFAULT_LAYOUT_CONFIG: LayoutConfig = {
  showSidebar: true,
  showGlobalNav: true,
  showLocalNav: false,
  autoCollapseSidebar: false,
};

/**
 * Layout configuration entries for pathname prefix matching.
 * Entries are checked in order; first match wins.
 */
export const LAYOUT_MAP: Array<{ prefix: string; config: Partial<LayoutConfig> }> = [
  {
    prefix: '/worktrees/',
    config: {
      showGlobalNav: false,
      showLocalNav: true,
    },
  },
  {
    prefix: '/sessions',
    config: {
      autoCollapseSidebar: true,
    },
  },
];

/**
 * Resolve pathname to a LayoutConfig by matching LAYOUT_MAP entries.
 * Pure function for testability.
 *
 * @param pathname - Current URL pathname
 * @returns Merged LayoutConfig
 */
export function resolveLayoutConfig(pathname: string): LayoutConfig {
  for (const entry of LAYOUT_MAP) {
    if (pathname.startsWith(entry.prefix)) {
      return { ...DEFAULT_LAYOUT_CONFIG, ...entry.config };
    }
  }
  return { ...DEFAULT_LAYOUT_CONFIG };
}

/**
 * Hook that returns layout configuration based on current pathname.
 *
 * @returns LayoutConfig for the current route
 */
export function useLayoutConfig(): LayoutConfig {
  const pathname = usePathname();
  return resolveLayoutConfig(pathname);
}
