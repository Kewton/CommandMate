/**
 * MobileTabBar Component
 *
 * Mobile tab bar for switching between terminal, history, files, and info views
 */

'use client';

import { useCallback, useMemo, memo } from 'react';

/**
 * Tab type for mobile view
 */
export type MobileTab = 'terminal' | 'history' | 'files' | 'memo' | 'info';

/**
 * Props for MobileTabBar component
 */
export interface MobileTabBarProps {
  /** Currently active tab */
  activeTab: MobileTab;
  /** Callback when tab is changed */
  onTabChange: (tab: MobileTab) => void;
  /** Whether there is new terminal output (shows badge) */
  hasNewOutput?: boolean;
  /** Whether there is a prompt waiting (shows badge) */
  hasPrompt?: boolean;
}

/**
 * Tab configuration
 */
interface TabConfig {
  id: MobileTab;
  label: string;
  icon: React.ReactNode;
}

/** Common SVG icon props */
interface IconProps {
  /** SVG path d attribute */
  path: string;
  /** Icon size class (default: w-5 h-5) */
  className?: string;
}

/**
 * Base icon component to reduce SVG attribute repetition
 */
const Icon = memo(function Icon({ path, className = 'w-5 h-5' }: IconProps) {
  return (
    <svg
      className={className}
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d={path}
      />
    </svg>
  );
});

/** Icon path definitions */
const ICON_PATHS = {
  terminal: 'M8 9l3 3-3 3m5 0h3M5 20h14a2 2 0 002-2V6a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z',
  history: 'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z',
  files: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
  memo: 'M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z',
  info: 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z',
} as const;

/**
 * Tab configurations
 * Order: Terminal, History, Files, Memo, Info
 */
const TABS: TabConfig[] = [
  { id: 'terminal', label: 'Terminal', icon: <Icon path={ICON_PATHS.terminal} /> },
  { id: 'history', label: 'History', icon: <Icon path={ICON_PATHS.history} /> },
  { id: 'files', label: 'Files', icon: <Icon path={ICON_PATHS.files} /> },
  { id: 'memo', label: 'Memo', icon: <Icon path={ICON_PATHS.memo} /> },
  { id: 'info', label: 'Info', icon: <Icon path={ICON_PATHS.info} /> },
];

/**
 * MobileTabBar - Tab bar for mobile navigation
 *
 * Displays tabs at the bottom of the screen for mobile navigation.
 * Supports notification badges for new output and prompts.
 */
export function MobileTabBar({
  activeTab,
  onTabChange,
  hasNewOutput = false,
  hasPrompt = false,
}: MobileTabBarProps) {
  /**
   * Handle tab click
   */
  const handleTabClick = useCallback(
    (tab: MobileTab) => {
      onTabChange(tab);
    },
    [onTabChange]
  );

  /**
   * Get tab styles based on active state
   */
  const getTabStyles = useCallback(
    (tabId: MobileTab) => {
      const isActive = tabId === activeTab;
      const baseStyles = 'flex flex-col items-center justify-center flex-1 py-2 px-1 transition-colors relative';
      const activeStyles = isActive
        ? 'text-blue-600 bg-blue-50'
        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50';
      return `${baseStyles} ${activeStyles}`;
    },
    [activeTab]
  );

  /**
   * Render badges for terminal tab
   */
  const renderBadges = useMemo(() => {
    return (
      <>
        {hasNewOutput && (
          <span
            data-testid="new-output-badge"
            className="absolute top-1 right-1 w-2 h-2 bg-green-500 rounded-full"
            aria-label="New output available"
          />
        )}
        {hasPrompt && (
          <span
            data-testid="prompt-badge"
            className="absolute top-1 right-3 w-2 h-2 bg-yellow-500 rounded-full"
            aria-label="Prompt waiting"
          />
        )}
      </>
    );
  }, [hasNewOutput, hasPrompt]);

  return (
    <nav
      data-testid="mobile-tab-bar"
      role="tablist"
      aria-label="Mobile navigation"
      className="fixed bottom-0 inset-x-0 bg-white border-t border-gray-200 flex pb-safe z-40"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-label={tab.label}
          onClick={() => handleTabClick(tab.id)}
          className={getTabStyles(tab.id)}
        >
          {tab.icon}
          <span className="text-xs mt-1">{tab.label}</span>
          {tab.id === 'terminal' && renderBadges}
        </button>
      ))}
    </nav>
  );
}

export default MobileTabBar;
