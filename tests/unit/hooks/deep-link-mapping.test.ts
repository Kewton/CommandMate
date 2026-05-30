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
import type { ActivityId } from '@/config/activity-bar-config';

/**
 * Expected mappings per design policy [DR2-006] + Issue #727 (activityId column).
 *
 * Activity Bar (PC, Issue #727):
 *   files  → 'files', git → 'git', notes → 'notes', logs → 'schedules',
 *   agent  → 'agent', timer → 'timer', history/terminal/info → null
 */
const MAPPING_TABLE: Array<{
  pane: DeepLinkPane;
  leftPaneTab: 'history' | 'files' | 'memo';
  mobileActivePane: 'terminal' | 'history' | 'files' | 'memo' | 'info';
  historySubTab: 'message' | 'git';
  activityId: ActivityId | null;
}> = [
  { pane: 'terminal', leftPaneTab: 'history', mobileActivePane: 'terminal', historySubTab: 'message', activityId: null },
  { pane: 'history',  leftPaneTab: 'history', mobileActivePane: 'history',  historySubTab: 'message', activityId: null },
  { pane: 'git',      leftPaneTab: 'history', mobileActivePane: 'history',  historySubTab: 'git',     activityId: 'git' },
  { pane: 'files',    leftPaneTab: 'files',   mobileActivePane: 'files',    historySubTab: 'message', activityId: 'files' },
  { pane: 'notes',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message', activityId: 'notes' },
  { pane: 'logs',     leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message', activityId: 'schedules' },
  { pane: 'agent',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message', activityId: 'agent' },
  { pane: 'timer',    leftPaneTab: 'memo',    mobileActivePane: 'memo',     historySubTab: 'message', activityId: 'timer' },
  { pane: 'info',     leftPaneTab: 'history', mobileActivePane: 'info',     historySubTab: 'message', activityId: null },
];

describe('Deep link pane mapping [DR2-006] + Issue #727', () => {
  for (const { pane, leftPaneTab, mobileActivePane, historySubTab, activityId } of MAPPING_TABLE) {
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

      it(`should map to activityId=${activityId === null ? 'null' : `"${activityId}"`}`, () => {
        const { result } = renderHook(() => useWorktreeTabState());
        expect(result.current.activityId).toBe(activityId);
      });
    });
  }
});
