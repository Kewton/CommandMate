/**
 * MobileTabBar Component
 *
 * Mobile tab bar for switching between terminal, history, files, and info views
 */

'use client';

import { useCallback, useMemo } from 'react';
import { SquareTerminal, Clock, Folder, FileText, Info } from 'lucide-react';
import { NotificationDot } from '@/components/common/NotificationDot';
import type { DeepLinkPane } from '@/types/ui-state';

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
  /** Whether an app update is available (shows badge on Info tab) - Issue #278 */
  hasUpdate?: boolean;
  /**
   * Optional callback to sync tab changes with searchParams (Issue #600).
   * Maps MobileTab to DeepLinkPane before calling.
   * memo -> 'notes', others map 1:1.
   */
  onSearchParamsChange?: (pane: DeepLinkPane) => void;
}

/**
 * Tab configuration
 */
interface TabConfig {
  id: MobileTab;
  label: string;
  icon: React.ReactNode;
}

/**
 * Map MobileTab to DeepLinkPane for searchParams integration (Issue #600).
 * memo tab maps to 'notes' (the first sub-pane); others map 1:1.
 */
function toDeepLinkPane(tab: MobileTab): DeepLinkPane {
  if (tab === 'memo') return 'notes';
  return tab;
}

/**
 * Tab configurations
 * Order: Terminal, History, Files, Memo, Info
 * Icons: lucide-react at 20px / strokeWidth 2 (see docs/design-system.md).
 */
const TABS: TabConfig[] = [
  { id: 'terminal', label: 'Terminal', icon: <SquareTerminal size={20} aria-hidden="true" /> },
  { id: 'history', label: 'History', icon: <Clock size={20} aria-hidden="true" /> },
  { id: 'files', label: 'Files', icon: <Folder size={20} aria-hidden="true" /> },
  { id: 'memo', label: 'Tools', icon: <FileText size={20} aria-hidden="true" /> },
  { id: 'info', label: 'Info', icon: <Info size={20} aria-hidden="true" /> },
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
  hasUpdate = false,
  onSearchParamsChange,
}: MobileTabBarProps) {
  /**
   * Get tab styles based on active state
   */
  const getTabStyles = useCallback(
    (tabId: MobileTab) => {
      const isActive = tabId === activeTab;
      const baseStyles = 'flex flex-col items-center justify-center flex-1 py-2 px-1 transition-colors relative';
      const activeStyles = isActive
        ? 'text-cyan-600 dark:text-cyan-400 bg-cyan-50 dark:bg-cyan-900/30'
        : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800';
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
      className="fixed bottom-0 inset-x-0 bg-white dark:bg-gray-900 border-t border-gray-200 dark:border-gray-700 flex pb-safe z-40"
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          data-testid={`mobile-tab-${tab.id}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-label={tab.label}
          onClick={() => {
            onTabChange(tab.id);
            onSearchParamsChange?.(toDeepLinkPane(tab.id));
          }}
          className={getTabStyles(tab.id)}
        >
          {tab.icon}
          <span className="text-xs mt-1">{tab.label}</span>
          {tab.id === 'terminal' && renderBadges}
          {tab.id === 'info' && hasUpdate && (
            <NotificationDot
              data-testid="info-update-badge"
              className="absolute top-1 right-1"
              aria-label="Update available"
            />
          )}
        </button>
      ))}
    </nav>
  );
}

export default MobileTabBar;
