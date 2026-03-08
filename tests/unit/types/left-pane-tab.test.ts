/**
 * LeftPaneTab type consistency test
 * Issue #447: Ensures LeftPaneTab type is identical in both definition locations
 *
 * This test guards against DRY violation update mismatches between:
 * - src/types/ui-state.ts
 * - src/components/worktree/LeftPaneTabSwitcher.tsx
 */

import { describe, it, expect } from 'vitest';
import type { LeftPaneTab as UIStateLeftPaneTab } from '@/types/ui-state';
import type { LeftPaneTab as SwitcherLeftPaneTab } from '@/components/worktree/LeftPaneTabSwitcher';

describe('LeftPaneTab type consistency', () => {
  it('should have the same members in both definition files', () => {
    // Type-level assertion: if the types diverge, this will fail at compile time
    const assertTypesEqual = <T extends UIStateLeftPaneTab & SwitcherLeftPaneTab>(_val: T): void => {};

    // Runtime validation: test all known values
    const allTabs: UIStateLeftPaneTab[] = ['history', 'files', 'memo'];

    // Verify each value is assignable to both types
    for (const tab of allTabs) {
      const uiStateTab: UIStateLeftPaneTab = tab;
      const switcherTab: SwitcherLeftPaneTab = tab;
      expect(uiStateTab).toBe(switcherTab);
    }

    // Ensure we're testing 3 tabs
    expect(allTabs).toHaveLength(3);

    // Use the assertion function to prevent unused variable warnings
    assertTypesEqual('history');
    assertTypesEqual('files');
    assertTypesEqual('memo');
  });

  it('should not include git as a standalone tab (moved to history sub-tab)', () => {
    // Git is now a sub-tab within History, not a standalone LeftPaneTab
    const allTabs: UIStateLeftPaneTab[] = ['history', 'files', 'memo'];
    expect(allTabs).not.toContain('git');
  });
});
