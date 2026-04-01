/**
 * Unit tests for deep link pane mapping logic
 * Issue #600: UX refresh - DeepLinkPane to LeftPaneTab/MobileActivePane mapping
 *
 * Tests the mapping tables defined in the design policy [DR2-006]:
 * | pane     | PC (LeftPaneTab) | Mobile (MobileTab) |
 * |----------|------------------|--------------------|
 * | terminal | history          | terminal           |
 * | history  | history(message) | history            |
 * | git      | history(git)     | history            |
 * | files    | files            | files              |
 * | notes    | memo(notes)      | memo               |
 * | logs     | memo(logs)       | memo               |
 * | agent    | memo(agent)      | memo               |
 * | timer    | memo(timer)      | memo               |
 * | info     | -                | info               |
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Mock next/navigation
const mockSearchParams = new URLSearchParams();
vi.mock('next/navigation', () => ({
  useSearchParams: () => mockSearchParams,
  useRouter: () => ({ replace: vi.fn() }),
  usePathname: () => '/worktrees/test-id',
}));

import { useWorktreeTabState } from '@/hooks/useWorktreeTabState';
import type { DeepLinkPane } from '@/types/ui-state';

/**
 * Expected mappings per design policy [DR2-006]
 */
const MAPPING_TABLE: Array<{
  pane: DeepLinkPane;
  leftPaneTab: 'history' | 'files' | 'memo';
  mobileActivePane: 'terminal' | 'history' | 'files' | 'memo' | 'info';
  historySubTab: 'message' | 'git';
}> = [
  { pane: 'terminal', leftPaneTab: 'history', mobileActivePane: 'terminal', historySubTab: 'message' },
  { pane: 'history',  leftPaneTab: 'history', mobileActivePane: 'history',  historySubTab: 'message' },
  { pane: 'git',      leftPaneTab: 'history', mobileActivePane: 'history',  historySubTab: 'git' },
  { pane: 'files',    leftPaneTab: 'files',   mobileActivePane: 'files',    historySubTab: 'message' },
  { pane: 'notes',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message' },
  { pane: 'logs',     leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message' },
  { pane: 'agent',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message' },
  { pane: 'timer',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message' },
  { pane: 'info',     leftPaneTab: 'history', mobileActivePane: 'info',     historySubTab: 'message' },
];

describe('Deep link pane mapping [DR2-006]', () => {
  for (const { pane, leftPaneTab, mobileActivePane, historySubTab } of MAPPING_TABLE) {
    describe(`pane="${pane}"`, () => {
      beforeEach(() => {
        mockSearchParams.set('pane', pane);
      });

      it(`should map to leftPaneTab="${leftPaneTab}"`, () => {
        const { result } = renderHook(() => useWorktreeTabState());
        expect(result.current.leftPaneTab).toBe(leftPaneTab);
      });

      it(`should map to mobileActivePane="${mobileActivePane}"`, () => {
        const { result } = renderHook(() => useWorktreeTabState());
        expect(result.current.mobileActivePane).toBe(mobileActivePane);
      });

      it(`should map to historySubTab="${historySubTab}"`, () => {
        const { result } = renderHook(() => useWorktreeTabState());
        expect(result.current.historySubTab).toBe(historySubTab);
      });
    });
  }
});
