/**
 * MobileTabBar Component
 *
 * Mobile tab bar for switching between terminal, history, files, and info views
 */

'use client';

import { useCallback, useMemo, useRef } from 'react';
import { SquareTerminal, Clock, Folder, Wrench, Info } from 'lucide-react';
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
  { id: 'memo', label: 'Tools', icon: <Wrench size={20} aria-hidden="true" /> },
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
  // [Issue #1127] Button refs for the ARIA tabs roving-tabindex pattern: arrow
  // keys move focus (and selection) to the neighbouring tab element directly.
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  /**
   * Get tab styles based on active state
   */
  const getTabStyles = useCallback(
    (tabId: MobileTab) => {
      const isActive = tabId === activeTab;
      // [Issue #1127] min-h-[44px] + touch-manipulation: guarantee a ≥44px tap
      // target and suppress the double-tap zoom delay on touch devices.
      const baseStyles = 'flex flex-col items-center justify-center flex-1 min-h-[44px] py-2 px-1 transition-colors relative touch-manipulation';
      // Issue #1080: match GlobalMobileNav — no cell fill; active is expressed by
      // accent text + a 2px top indicator bar (rendered in the button body).
      const activeStyles = isActive
        ? 'text-accent-600 dark:text-accent-400'
        : 'text-muted-foreground hover:text-foreground';
      return `${baseStyles} ${activeStyles}`;
    },
    [activeTab]
  );

  /**
   * Activate a tab by index: notify the parent and mirror to searchParams.
   */
  const activateTab = useCallback(
    (tab: MobileTab) => {
      onTabChange(tab);
      onSearchParamsChange?.(toDeepLinkPane(tab));
    },
    [onTabChange, onSearchParamsChange]
  );

  /**
   * ARIA tabs keyboard model (Issue #1127): Arrow keys move between tabs with
   * wraparound, Home/End jump to the ends. Selection follows focus (automatic
   * activation), matching a bottom tab bar's tap semantics.
   */
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
      let nextIndex: number | null = null;
      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          nextIndex = (index + 1) % TABS.length;
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          nextIndex = (index - 1 + TABS.length) % TABS.length;
          break;
        case 'Home':
          nextIndex = 0;
          break;
        case 'End':
          nextIndex = TABS.length - 1;
          break;
        default:
          return;
      }
      event.preventDefault();
      tabRefs.current[nextIndex]?.focus();
      activateTab(TABS[nextIndex].id);
    },
    [activateTab]
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
            className="absolute top-1 right-1 w-2 h-2 bg-success rounded-full"
            aria-label="New output available"
          />
        )}
        {hasPrompt && (
          <span
            data-testid="prompt-badge"
            className="absolute top-1 right-3 w-2 h-2 bg-warning rounded-full"
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
      className="fixed bottom-0 inset-x-0 border-t border-border bg-background supports-[backdrop-filter]:bg-background/80 backdrop-blur-md flex pb-safe z-40"
    >
      {TABS.map((tab, index) => (
        <button
          key={tab.id}
          ref={(el) => {
            tabRefs.current[index] = el;
          }}
          type="button"
          data-testid={`mobile-tab-${tab.id}`}
          role="tab"
          aria-selected={activeTab === tab.id}
          aria-label={tab.label}
          // Roving tabindex: only the active tab is in the page tab order; the
          // rest are reached with the arrow keys (Issue #1127).
          tabIndex={activeTab === tab.id ? 0 : -1}
          onClick={() => activateTab(tab.id)}
          onKeyDown={(e) => handleKeyDown(e, index)}
          className={getTabStyles(tab.id)}
        >
          {activeTab === tab.id && (
            <span
              aria-hidden="true"
              className="absolute top-0 inset-x-2 h-0.5 rounded-full bg-accent-500"
            />
          )}
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
