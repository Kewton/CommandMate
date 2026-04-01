/**
 * useWorktreeTabState - Deep link tab state management hook.
 *
 * Issue #600: UX refresh - manages ?pane= searchParam for deep linking.
 * Validates pane values using isDeepLinkPane() type guard [DR4-010].
 * Provides conversion to LeftPaneTab, MobileActivePane, and HistorySubTab.
 *
 * Security: Only validated pane values (via isDeepLinkPane()) are used internally.
 * Raw searchParams.get('pane') values are never passed to components directly.
 */

'use client';

import { useCallback, useMemo } from 'react';
import { useSearchParams, useRouter, usePathname } from 'next/navigation';
import { normalizeDeepLinkPane } from '@/lib/deep-link-validator';
import type { DeepLinkPane, MobileActivePane, LeftPaneTab, HistorySubTab } from '@/types/ui-state';

/**
 * Return value of useWorktreeTabState hook.
 */
export interface UseWorktreeTabStateReturn {
  /** Current validated DeepLinkPane value */
  activePane: DeepLinkPane;
  /** Derived LeftPaneTab for desktop view */
  leftPaneTab: LeftPaneTab;
  /** Derived MobileActivePane for mobile view */
  mobileActivePane: MobileActivePane;
  /** Derived HistorySubTab (message or git) */
  historySubTab: HistorySubTab;
  /** Update the active pane via router.replace (scroll:false) */
  setPane: (pane: DeepLinkPane) => void;
}

/**
 * Map DeepLinkPane to LeftPaneTab for desktop.
 * terminal -> history (default desktop left pane)
 * git -> history (git is a sub-tab)
 * notes/logs/agent/timer -> memo
 * info -> history (no dedicated desktop left pane for info)
 */
function toLeftPaneTab(pane: DeepLinkPane): LeftPaneTab {
  switch (pane) {
    case 'history':
    case 'git':
    case 'terminal':
    case 'info':
      return 'history';
    case 'files':
      return 'files';
    case 'notes':
    case 'logs':
    case 'agent':
    case 'timer':
      return 'memo';
    default: {
      const _exhaustive: never = pane;
      void _exhaustive;
      return 'history';
    }
  }
}

/**
 * Map DeepLinkPane to MobileActivePane.
 */
function toMobileActivePane(pane: DeepLinkPane): MobileActivePane {
  switch (pane) {
    case 'terminal':
      return 'terminal';
    case 'history':
    case 'git':
      return 'history';
    case 'files':
      return 'files';
    case 'notes':
    case 'logs':
    case 'agent':
    case 'timer':
      return 'memo';
    case 'info':
      return 'info';
    default: {
      const _exhaustive: never = pane;
      void _exhaustive;
      return 'terminal';
    }
  }
}

/**
 * Derive HistorySubTab from DeepLinkPane.
 */
function toHistorySubTab(pane: DeepLinkPane): HistorySubTab {
  return pane === 'git' ? 'git' : 'message';
}

/**
 * Hook for managing tab state via ?pane= searchParam.
 *
 * Validates pane values at the boundary using isDeepLinkPane() [DR4-010].
 * Provides derived values for desktop (LeftPaneTab) and mobile (MobileActivePane).
 */
export function useWorktreeTabState(): UseWorktreeTabStateReturn {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  // Validate pane value at boundary [DR4-010]
  const activePane = useMemo(() => {
    const raw = searchParams.get('pane');
    return normalizeDeepLinkPane(raw);
  }, [searchParams]);

  const leftPaneTab = useMemo(() => toLeftPaneTab(activePane), [activePane]);
  const mobileActivePane = useMemo(() => toMobileActivePane(activePane), [activePane]);
  const historySubTab = useMemo(() => toHistorySubTab(activePane), [activePane]);

  const setPane = useCallback(
    (pane: DeepLinkPane) => {
      if (pane === activePane) return;
      const params = new URLSearchParams(searchParams.toString());
      params.set('pane', pane);
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [activePane, pathname, router, searchParams]
  );

  return {
    activePane,
    leftPaneTab,
    mobileActivePane,
    historySubTab,
    setPane,
  };
}
