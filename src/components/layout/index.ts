/**
 * Layout Components Index
 * Exports all layout components
 */

export { Header } from './Header';
export type { HeaderProps } from './Header';

export { MainLayout } from './MainLayout';
export type { MainLayoutProps } from './MainLayout';

export { AppShell } from './AppShell';
export type { AppShellProps } from './AppShell';

// Issue #2682: the shell is mounted by the root layout through this gate.
export { AppShellGate, shouldRenderShell } from './AppShellGate';

export { VersionMismatchBanner } from './VersionMismatchBanner';

export { Sidebar } from './Sidebar';

export { SidebarToggle } from './SidebarToggle';

export { RepositoryTabBar, REPOSITORY_TAB_BAR_HEIGHT } from './RepositoryTabBar';

export { RepositoryTabBarModeSelector } from './RepositoryTabBarModeSelector';
