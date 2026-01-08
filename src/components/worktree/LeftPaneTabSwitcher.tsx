/**
 * LeftPaneTabSwitcher Component
 *
 * Tab switcher for the left pane in desktop layout.
 * Allows switching between 'history' and 'files' views.
 */

'use client';

import React, { useCallback, memo } from 'react';

// ============================================================================
// Types
// ============================================================================

/**
 * Available tabs for the left pane
 */
export type LeftPaneTab = 'history' | 'files';

export interface LeftPaneTabSwitcherProps {
  /** Currently active tab */
  activeTab: LeftPaneTab;
  /** Callback when tab is changed */
  onTabChange: (tab: LeftPaneTab) => void;
  /** Additional CSS classes */
  className?: string;
}

interface TabConfig {
  id: LeftPaneTab;
  label: string;
  icon: React.ReactNode;
}

// ============================================================================
// Icon Components
// ============================================================================

const HistoryIcon = memo(function HistoryIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"
      />
    </svg>
  );
});

const FilesIcon = memo(function FilesIcon() {
  return (
    <svg
      className="w-4 h-4"
      fill="none"
      stroke="currentColor"
      viewBox="0 0 24 24"
      aria-hidden="true"
    >
      <path
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth={2}
        d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
      />
    </svg>
  );
});

// ============================================================================
// Tab Configuration
// ============================================================================

const TABS: TabConfig[] = [
  { id: 'history', label: 'History', icon: <HistoryIcon /> },
  { id: 'files', label: 'Files', icon: <FilesIcon /> },
];

// ============================================================================
// Main Component
// ============================================================================

/**
 * LeftPaneTabSwitcher - Tab buttons for switching left pane content
 *
 * @example
 * ```tsx
 * <LeftPaneTabSwitcher
 *   activeTab="history"
 *   onTabChange={(tab) => setActiveTab(tab)}
 * />
 * ```
 */
export const LeftPaneTabSwitcher = memo(function LeftPaneTabSwitcher({
  activeTab,
  onTabChange,
  className = '',
}: LeftPaneTabSwitcherProps) {
  /**
   * Handle tab click
   */
  const handleTabClick = useCallback(
    (tab: LeftPaneTab) => {
      onTabChange(tab);
    },
    [onTabChange]
  );

  /**
   * Handle keyboard navigation
   */
  const handleKeyDown = useCallback(
    (tab: LeftPaneTab, e: React.KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onTabChange(tab);
      }
    },
    [onTabChange]
  );

  /**
   * Get tab styles based on active state
   */
  const getTabStyles = useCallback(
    (tabId: LeftPaneTab) => {
      const isActive = tabId === activeTab;
      const baseStyles =
        'flex items-center gap-2 px-4 py-2 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-blue-500 focus:ring-inset';
      const activeStyles = isActive
        ? 'bg-blue-50 text-blue-600 border-b-2 border-blue-600'
        : 'text-gray-500 hover:text-gray-700 hover:bg-gray-50';
      return `${baseStyles} ${activeStyles}`;
    },
    [activeTab]
  );

  return (
    <div
      role="tablist"
      aria-label="Left pane view switcher"
      className={`flex border-b border-gray-200 bg-white ${className}`}
    >
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-label={tab.label}
          tabIndex={0}
          onClick={() => handleTabClick(tab.id)}
          onKeyDown={(e) => handleKeyDown(tab.id, e)}
          className={getTabStyles(tab.id)}
        >
          {tab.icon}
          <span>{tab.label}</span>
        </button>
      ))}
    </div>
  );
});

export default LeftPaneTabSwitcher;
