/**
 * Unit Tests for useFileTabs hook
 *
 * Issue #438: File panel tabs for PC desktop view
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFileTabs, MAX_FILE_TABS, fileTabsReducer, selectTabsToClose } from '@/hooks/useFileTabs';
import type { FileTabsState, FileTabsAction, FileTab, FileTabsActions } from '@/hooks/useFileTabs';
import type { FileContent } from '@/types/models';

// ============================================================================
// Reducer Tests
// ============================================================================

describe('fileTabsReducer', () => {
  const initialState: FileTabsState = { tabs: [], activeIndex: null };

  describe('OPEN_FILE', () => {
    it('should add a new tab and set activeIndex', () => {
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'src/index.ts' };
      const result = fileTabsReducer(initialState, action);

      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].path).toBe('src/index.ts');
      expect(result.tabs[0].name).toBe('index.ts');
      expect(result.tabs[0].content).toBeNull();
      expect(result.tabs[0].loading).toBe(false);
      expect(result.tabs[0].error).toBeNull();
      expect(result.activeIndex).toBe(0);
    });

    it('should activate existing tab if path already open', () => {
      const stateWithTab: FileTabsState = {
        tabs: [
          { path: 'src/a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'src/b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'src/b.ts' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs).toHaveLength(2);
      expect(result.activeIndex).toBe(1);
    });

    it('should not add tab when at MAX_FILE_TABS limit', () => {
      const tabs: FileTab[] = Array.from({ length: MAX_FILE_TABS }, (_, i) => ({
        path: `file${i}.ts`,
        name: `file${i}.ts`,
        content: null,
        loading: false,
        error: null,
        isDirty: false,
      }));
      const stateAtLimit: FileTabsState = { tabs, activeIndex: 0 };
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'new-file.ts' };
      const result = fileTabsReducer(stateAtLimit, action);

      // Should not add new tab
      expect(result.tabs).toHaveLength(MAX_FILE_TABS);
      expect(result).toBe(stateAtLimit); // Same reference = no change
    });

    it('should extract file name from path correctly', () => {
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'deep/nested/dir/component.tsx' };
      const result = fileTabsReducer(initialState, action);
      expect(result.tabs[0].name).toBe('component.tsx');
    });

    it('should use full path as name if no directory separator', () => {
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'README.md' };
      const result = fileTabsReducer(initialState, action);
      expect(result.tabs[0].name).toBe('README.md');
    });
  });

  describe('CLOSE_TAB', () => {
    it('should remove the specified tab', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'c.ts', name: 'c.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 1,
      };
      const action: FileTabsAction = { type: 'CLOSE_TAB', path: 'b.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs).toHaveLength(2);
      expect(result.tabs.map(t => t.path)).toEqual(['a.ts', 'c.ts']);
    });

    it('should set activeIndex to null when last tab is closed', () => {
      const stateWithOneTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'CLOSE_TAB', path: 'a.ts' };
      const result = fileTabsReducer(stateWithOneTab, action);

      expect(result.tabs).toHaveLength(0);
      expect(result.activeIndex).toBeNull();
    });

    it('should adjust activeIndex when closing a tab before the active tab', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'c.ts', name: 'c.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 2,
      };
      const action: FileTabsAction = { type: 'CLOSE_TAB', path: 'a.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs).toHaveLength(2);
      expect(result.activeIndex).toBe(1); // Was 2, minus 1 because tab before it was removed
    });

    it('should activate previous tab when closing the active tab', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'c.ts', name: 'c.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 2,
      };
      const action: FileTabsAction = { type: 'CLOSE_TAB', path: 'c.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs).toHaveLength(2);
      expect(result.activeIndex).toBe(1); // Activate the previous tab
    });

    it('should not change state when closing non-existent tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'CLOSE_TAB', path: 'nonexistent.ts' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });
  });

  describe('ACTIVATE_TAB', () => {
    it('should set activeIndex to the matching tab', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'ACTIVATE_TAB', path: 'b.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.activeIndex).toBe(1);
    });

    it('should not change state when path not found', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'ACTIVATE_TAB', path: 'nonexistent.ts' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });
  });

  describe('SET_CONTENT', () => {
    it('should set content for the specified tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: true, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const mockContent: FileContent = {
        path: 'a.ts',
        content: 'const x = 1;',
        extension: 'ts',
        worktreePath: '/repo',
      };
      const action: FileTabsAction = { type: 'SET_CONTENT', path: 'a.ts', content: mockContent };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].content).toBe(mockContent);
      expect(result.tabs[0].loading).toBe(false);
      expect(result.tabs[0].error).toBeNull();
    });
  });

  describe('SET_LOADING', () => {
    it('should set loading state for the specified tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_LOADING', path: 'a.ts', loading: true };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].loading).toBe(true);
    });
  });

  describe('SET_ERROR', () => {
    it('should set error for the specified tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: true, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_ERROR', path: 'a.ts', error: 'File not found' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].error).toBe('File not found');
      expect(result.tabs[0].loading).toBe(false);
    });
  });

  describe('RENAME_FILE', () => {
    it('should update path and name for the matching tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'src/old.ts', name: 'old.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'RENAME_FILE', oldPath: 'src/old.ts', newPath: 'src/new.ts' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].path).toBe('src/new.ts');
      expect(result.tabs[0].name).toBe('new.ts');
    });

    it('should not change state when old path not found', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'RENAME_FILE', oldPath: 'nonexistent.ts', newPath: 'new.ts' };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });
  });

  describe('DELETE_FILE', () => {
    it('should remove the tab for the deleted file', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'DELETE_FILE', path: 'a.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs).toHaveLength(1);
      expect(result.tabs[0].path).toBe('b.ts');
    });
  });

  // ============================================================================
  // MOVE_TO_FRONT Tests (Issue #505)
  // ============================================================================

  describe('MOVE_TO_FRONT', () => {
    it('should move tab to index 0', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'c.ts', name: 'c.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'MOVE_TO_FRONT', path: 'c.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs[0].path).toBe('c.ts');
      expect(result.tabs[1].path).toBe('a.ts');
      expect(result.tabs[2].path).toBe('b.ts');
      expect(result.activeIndex).toBe(0);
    });

    it('should not change state when tab is already first', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'MOVE_TO_FRONT', path: 'a.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result).toBe(stateWithTabs);
    });

    it('should not change state when path not found', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'MOVE_TO_FRONT', path: 'nonexistent.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result).toBe(stateWithTabs);
    });

    it('should set activeIndex to 0 after moving', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'c.ts', name: 'c.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 2,
      };
      const action: FileTabsAction = { type: 'MOVE_TO_FRONT', path: 'b.ts' };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.activeIndex).toBe(0);
    });
  });

  describe('CLOSE_ALL', () => {
    it('should clear all tabs and reset activeIndex to null', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 1,
      };
      const result = fileTabsReducer(stateWithTabs, { type: 'CLOSE_ALL' });

      expect(result.tabs).toEqual([]);
      expect(result.activeIndex).toBeNull();
    });

    it('should return the same reference when already empty (no-op)', () => {
      const emptyState: FileTabsState = { tabs: [], activeIndex: null };
      const result = fileTabsReducer(emptyState, { type: 'CLOSE_ALL' });

      expect(result).toBe(emptyState);
    });
  });

  // ==========================================================================
  // Bulk close (Issue #2260)
  // ==========================================================================

  /** State with tabs a.ts..(n) and the given active index. */
  function bulkState(paths: string[], activeIndex: number | null): FileTabsState {
    return {
      tabs: paths.map((path) => ({
        path,
        name: path,
        content: null,
        loading: false,
        error: null,
        isDirty: false,
      })),
      activeIndex,
    };
  }

  const paths = (state: FileTabsState): string[] => state.tabs.map((t) => t.path);

  describe('CLOSE_OTHERS (Issue #2260)', () => {
    it('keeps only the anchor tab and activates it', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 3);
      const result = fileTabsReducer(state, { type: 'CLOSE_OTHERS', path: 'b.ts' });

      expect(paths(result)).toEqual(['b.ts']);
      // The active tab (d.ts) was closed, so the surviving anchor takes over.
      expect(result.activeIndex).toBe(0);
    });

    it('keeps the anchor active when the anchor was already active', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts'], 1);
      const result = fileTabsReducer(state, { type: 'CLOSE_OTHERS', path: 'b.ts' });

      expect(paths(result)).toEqual(['b.ts']);
      expect(result.activeIndex).toBe(0);
    });

    it('is a no-op when the anchor is the only open tab', () => {
      const state = bulkState(['a.ts'], 0);
      expect(fileTabsReducer(state, { type: 'CLOSE_OTHERS', path: 'a.ts' })).toBe(state);
    });

    it('is a no-op when the anchor is not open', () => {
      const state = bulkState(['a.ts', 'b.ts'], 0);
      expect(fileTabsReducer(state, { type: 'CLOSE_OTHERS', path: 'zz.ts' })).toBe(state);
    });
  });

  describe('CLOSE_TO_RIGHT (Issue #2260)', () => {
    it('keeps the anchor and everything left of it, closing only what follows', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 0);
      const result = fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'b.ts' });

      // Boundary: the anchor itself survives, its immediate neighbour does not.
      expect(paths(result)).toEqual(['a.ts', 'b.ts']);
      expect(result.activeIndex).toBe(0);
    });

    it('moves the selection onto the anchor when the active tab is closed', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 3);
      const result = fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'b.ts' });

      expect(paths(result)).toEqual(['a.ts', 'b.ts']);
      expect(result.activeIndex).toBe(1);
    });

    it('leaves the selection alone when the active tab survives', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 1);
      const result = fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'c.ts' });

      expect(paths(result)).toEqual(['a.ts', 'b.ts', 'c.ts']);
      expect(result.activeIndex).toBe(1);
    });

    it('is a no-op when the anchor is the rightmost tab', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts'], 0);
      expect(fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'c.ts' })).toBe(state);
    });

    it('is a no-op when the anchor is not open', () => {
      const state = bulkState(['a.ts', 'b.ts'], 0);
      expect(fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'zz.ts' })).toBe(state);
    });

    it('matches closing the same tabs one at a time from the right', () => {
      const state = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts'], 4);

      const batched = fileTabsReducer(state, { type: 'CLOSE_TO_RIGHT', path: 'b.ts' });
      const oneAtATime = ['e.ts', 'd.ts', 'c.ts'].reduce(
        (acc, path) => fileTabsReducer(acc, { type: 'CLOSE_TAB', path }),
        state,
      );

      expect(paths(batched)).toEqual(paths(oneAtATime));
      expect(batched.activeIndex).toBe(oneAtATime.activeIndex);
    });
  });

  describe('selectTabsToClose (Issue #2260)', () => {
    const tabs = bulkState(['a.ts', 'b.ts', 'c.ts', 'd.ts'], 0).tabs;

    it("'all' returns every open path regardless of the anchor", () => {
      expect(selectTabsToClose(tabs, 'zz.ts', 'all')).toEqual(['a.ts', 'b.ts', 'c.ts', 'd.ts']);
    });

    it("'others' returns every path but the anchor, in tab-bar order", () => {
      expect(selectTabsToClose(tabs, 'b.ts', 'others')).toEqual(['a.ts', 'c.ts', 'd.ts']);
    });

    it("'right' excludes the anchor and includes its immediate neighbour", () => {
      const selected = selectTabsToClose(tabs, 'b.ts', 'right');

      expect(selected).toEqual(['c.ts', 'd.ts']);
      expect(selected).not.toContain('b.ts');
    });

    it("'right' returns nothing for the rightmost tab", () => {
      expect(selectTabsToClose(tabs, 'd.ts', 'right')).toEqual([]);
    });

    it('returns nothing when the anchor is not open', () => {
      expect(selectTabsToClose(tabs, 'zz.ts', 'others')).toEqual([]);
      expect(selectTabsToClose(tabs, 'zz.ts', 'right')).toEqual([]);
    });
  });

  // ============================================================================
  // MAX_FILE_TABS regression guard (Issue #505) [DR3-002]
  // ============================================================================

  describe('MAX_FILE_TABS constant', () => {
    it('should be 30', () => {
      expect(MAX_FILE_TABS).toBe(30);
    });
  });

  describe('RESTORE with MAX_FILE_TABS=30', () => {
    it('should restore up to 30 tabs', () => {
      const paths = Array.from({ length: 30 }, (_, i) => `file${i}.ts`);
      const action: FileTabsAction = { type: 'RESTORE', paths, activePath: 'file0.ts' };
      const result = fileTabsReducer(initialState, action);

      expect(result.tabs).toHaveLength(30);
    });

    it('should truncate if more than MAX_FILE_TABS paths are provided', () => {
      const paths = Array.from({ length: 35 }, (_, i) => `file${i}.ts`);
      const action: FileTabsAction = { type: 'RESTORE', paths, activePath: 'file0.ts' };
      const result = fileTabsReducer(initialState, action);

      expect(result.tabs).toHaveLength(MAX_FILE_TABS);
    });
  });

  // ============================================================================
  // isDirty Tests (Issue #469)
  // ============================================================================

  describe('isDirty flag', () => {
    it('OPEN_FILE should initialize isDirty as false', () => {
      const action: FileTabsAction = { type: 'OPEN_FILE', path: 'src/index.ts' };
      const result = fileTabsReducer(initialState, action);

      expect(result.tabs[0].isDirty).toBe(false);
    });

    it('RESTORE should set isDirty to false for all tabs', () => {
      const action: FileTabsAction = {
        type: 'RESTORE',
        paths: ['a.ts', 'b.ts'],
        activePath: 'a.ts',
      };
      const result = fileTabsReducer(initialState, action);

      expect(result.tabs[0].isDirty).toBe(false);
      expect(result.tabs[1].isDirty).toBe(false);
    });

    it('SET_CONTENT should reset isDirty to false', () => {
      const stateWithDirtyTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: true, error: null, isDirty: true }],
        activeIndex: 0,
      };
      const mockContent: FileContent = {
        path: 'a.ts',
        content: 'const x = 1;',
        extension: 'ts',
        worktreePath: '/repo',
      };
      const action: FileTabsAction = { type: 'SET_CONTENT', path: 'a.ts', content: mockContent };
      const result = fileTabsReducer(stateWithDirtyTab, action);

      expect(result.tabs[0].isDirty).toBe(false);
    });

    it('SET_DIRTY should set isDirty to true for the specified tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: true };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].isDirty).toBe(true);
    });

    it('SET_DIRTY should set isDirty to false for the specified tab', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: true }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: false };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result.tabs[0].isDirty).toBe(false);
    });

    it('SET_DIRTY should only affect the specified tab', () => {
      const stateWithTabs: FileTabsState = {
        tabs: [
          { path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false },
          { path: 'b.ts', name: 'b.ts', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: true };
      const result = fileTabsReducer(stateWithTabs, action);

      expect(result.tabs[0].isDirty).toBe(true);
      expect(result.tabs[1].isDirty).toBe(false);
    });

    it('SET_DIRTY should return same state if path not found', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'nonexistent.ts', isDirty: true };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });

    // [Issue #675] Re-render loop guard: same-value SET_DIRTY must be a no-op
    it('SET_DIRTY should return same state reference when isDirty is already the same value (false→false)', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: false };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });

    it('SET_DIRTY should return same state reference when isDirty is already the same value (true→true)', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: true }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: true };
      const result = fileTabsReducer(stateWithTab, action);

      expect(result).toBe(stateWithTab);
    });

    it('SET_DIRTY applied twice with the same value returns a stable reference', () => {
      const stateWithTab: FileTabsState = {
        tabs: [{ path: 'a.ts', name: 'a.ts', content: null, loading: false, error: null, isDirty: false }],
        activeIndex: 0,
      };
      const action: FileTabsAction = { type: 'SET_DIRTY', path: 'a.ts', isDirty: true };
      const first = fileTabsReducer(stateWithTab, action);
      const second = fileTabsReducer(first, action);

      expect(first.tabs[0].isDirty).toBe(true);
      expect(second).toBe(first);
    });

    // [Issue #681] Verify the SET_DIRTY no-op guard is extension-agnostic.
    // The same fix that protects .md must also protect .yaml/.yml/.html (which share
    // the upstream dispatch path even though .html routes to HtmlPreview, not MarkdownEditor).
    it('SET_DIRTY no-op short-circuit applies regardless of file extension (#681)', () => {
      const mixedState: FileTabsState = {
        tabs: [
          { path: 'note.md', name: 'note.md', content: null, loading: false, error: null, isDirty: true },
          { path: 'config.yaml', name: 'config.yaml', content: null, loading: false, error: null, isDirty: false },
          { path: 'manifest.yml', name: 'manifest.yml', content: null, loading: false, error: null, isDirty: true },
          { path: 'index.html', name: 'index.html', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };

      const noOpActions: FileTabsAction[] = [
        { type: 'SET_DIRTY', path: 'note.md', isDirty: true },
        { type: 'SET_DIRTY', path: 'config.yaml', isDirty: false },
        { type: 'SET_DIRTY', path: 'manifest.yml', isDirty: true },
        { type: 'SET_DIRTY', path: 'index.html', isDirty: false },
      ];

      for (const action of noOpActions) {
        const result = fileTabsReducer(mixedState, action);
        expect(result).toBe(mixedState);
      }
    });

    it('SET_DIRTY same-value rapid-fire dispatches across extensions never produce a new state reference (#681)', () => {
      const mixedState: FileTabsState = {
        tabs: [
          { path: 'doc.md', name: 'doc.md', content: null, loading: false, error: null, isDirty: false },
          { path: 'app.yaml', name: 'app.yaml', content: null, loading: false, error: null, isDirty: false },
          { path: 'page.html', name: 'page.html', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };

      let current = mixedState;
      const paths = ['doc.md', 'app.yaml', 'page.html'];
      for (let i = 0; i < 30; i++) {
        const path = paths[i % paths.length];
        current = fileTabsReducer(current, { type: 'SET_DIRTY', path, isDirty: false });
      }

      expect(current).toBe(mixedState);
    });

    it('SET_DIRTY value transition (false→true) on a yaml/html tab still produces a new state, then stabilises (#681)', () => {
      const mixedState: FileTabsState = {
        tabs: [
          { path: 'config.yaml', name: 'config.yaml', content: null, loading: false, error: null, isDirty: false },
          { path: 'index.html', name: 'index.html', content: null, loading: false, error: null, isDirty: false },
        ],
        activeIndex: 0,
      };

      const flipYaml = fileTabsReducer(mixedState, { type: 'SET_DIRTY', path: 'config.yaml', isDirty: true });
      expect(flipYaml).not.toBe(mixedState);
      expect(flipYaml.tabs[0].isDirty).toBe(true);

      const stableYaml = fileTabsReducer(flipYaml, { type: 'SET_DIRTY', path: 'config.yaml', isDirty: true });
      expect(stableYaml).toBe(flipYaml);

      const flipHtml = fileTabsReducer(stableYaml, { type: 'SET_DIRTY', path: 'index.html', isDirty: true });
      expect(flipHtml).not.toBe(stableYaml);
      expect(flipHtml.tabs[1].isDirty).toBe(true);

      const stableHtml = fileTabsReducer(flipHtml, { type: 'SET_DIRTY', path: 'index.html', isDirty: true });
      expect(stableHtml).toBe(flipHtml);
    });
  });
});

// ============================================================================
// Hook Integration Tests
// ============================================================================

describe('useFileTabs', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('should initialize with empty state', () => {
    const { result } = renderHook(() => useFileTabs('test-wt'));

    expect(result.current[0].tabs).toHaveLength(0);
    expect(result.current[0].activeIndex).toBeNull();
  });

  describe('openFile', () => {
    it('should return "opened" when opening a new file', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      let returnValue: string;
      act(() => {
        returnValue = result.current[1].openFile('src/index.ts');
      });

      expect(returnValue!).toBe('opened');
      expect(result.current[0].tabs).toHaveLength(1);
      expect(result.current[0].activeIndex).toBe(0);
    });

    it('should return "activated" when opening an already open file', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('src/index.ts');
      });

      let returnValue: string;
      act(() => {
        returnValue = result.current[1].openFile('src/index.ts');
      });

      expect(returnValue!).toBe('activated');
      expect(result.current[0].tabs).toHaveLength(1);
    });

    it('should return "limit_reached" when at max tabs', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      // Open MAX_FILE_TABS files
      for (let i = 0; i < MAX_FILE_TABS; i++) {
        act(() => {
          result.current[1].openFile(`file${i}.ts`);
        });
      }

      let returnValue: string;
      act(() => {
        returnValue = result.current[1].openFile('extra-file.ts');
      });

      expect(returnValue!).toBe('limit_reached');
      expect(result.current[0].tabs).toHaveLength(MAX_FILE_TABS);
    });
  });

  describe('closeTab', () => {
    it('should close the specified tab', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('a.ts');
        result.current[1].openFile('b.ts');
      });

      act(() => {
        result.current[1].closeTab('a.ts');
      });

      expect(result.current[0].tabs).toHaveLength(1);
      expect(result.current[0].tabs[0].path).toBe('b.ts');
    });
  });

  describe('closeAllTabs', () => {
    it('should close every open tab and clear the persisted key', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('a.ts');
        result.current[1].openFile('b.ts');
        result.current[1].openFile('c.ts');
      });
      expect(result.current[0].tabs).toHaveLength(3);

      act(() => {
        result.current[1].closeAllTabs();
      });

      expect(result.current[0].tabs).toHaveLength(0);
      expect(result.current[0].activeIndex).toBeNull();
      // Persisted empty state should not restore any tabs.
      const raw = window.localStorage.getItem('commandmate:file-tabs:test-wt');
      const parsed = raw ? JSON.parse(raw) : { paths: [] };
      expect(parsed.paths).toEqual([]);
    });

    it('closeAllTabs identity is stable across renders', () => {
      const { result, rerender } = renderHook(() => useFileTabs('test-wt'));
      const fn1 = result.current[1].closeAllTabs;
      rerender();
      expect(Object.is(fn1, result.current[1].closeAllTabs)).toBe(true);
    });
  });

  describe('closeOtherTabs / closeTabsToRight (Issue #2260)', () => {
    function openThree() {
      const { result, rerender } = renderHook(() => useFileTabs('test-wt'));
      act(() => {
        result.current[1].openFile('a.ts');
        result.current[1].openFile('b.ts');
        result.current[1].openFile('c.ts');
      });
      return { result, rerender };
    }

    it('closeOtherTabs leaves only the anchor open', () => {
      const { result } = openThree();

      act(() => {
        result.current[1].closeOtherTabs('b.ts');
      });

      expect(result.current[0].tabs.map((t) => t.path)).toEqual(['b.ts']);
      expect(result.current[0].activeIndex).toBe(0);
    });

    it('closeTabsToRight keeps the anchor and everything before it', () => {
      const { result } = openThree();

      act(() => {
        result.current[1].closeTabsToRight('a.ts');
      });

      expect(result.current[0].tabs.map((t) => t.path)).toEqual(['a.ts']);
      expect(result.current[0].activeIndex).toBe(0);
    });

    it('both dispatcher identities are stable across renders', () => {
      const { result, rerender } = openThree();
      const others = result.current[1].closeOtherTabs;
      const toRight = result.current[1].closeTabsToRight;
      rerender();

      expect(Object.is(others, result.current[1].closeOtherTabs)).toBe(true);
      expect(Object.is(toRight, result.current[1].closeTabsToRight)).toBe(true);
    });
  });

  describe('activateTab', () => {
    it('should activate the specified tab', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('a.ts');
        result.current[1].openFile('b.ts');
      });

      act(() => {
        result.current[1].activateTab('a.ts');
      });

      expect(result.current[0].activeIndex).toBe(0);
    });
  });

  describe('onFileRenamed', () => {
    it('should update tab path and name', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('src/old.ts');
      });

      act(() => {
        result.current[1].onFileRenamed('src/old.ts', 'src/new.ts');
      });

      expect(result.current[0].tabs[0].path).toBe('src/new.ts');
      expect(result.current[0].tabs[0].name).toBe('new.ts');
    });
  });

  describe('onFileDeleted', () => {
    it('should remove the tab for the deleted file', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('a.ts');
      });

      act(() => {
        result.current[1].onFileDeleted('a.ts');
      });

      expect(result.current[0].tabs).toHaveLength(0);
      expect(result.current[0].activeIndex).toBeNull();
    });
  });

  describe('moveToFront', () => {
    it('should move specified tab to front', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      act(() => {
        result.current[1].openFile('a.ts');
        result.current[1].openFile('b.ts');
        result.current[1].openFile('c.ts');
      });

      act(() => {
        result.current[1].moveToFront('c.ts');
      });

      expect(result.current[0].tabs[0].path).toBe('c.ts');
      expect(result.current[0].activeIndex).toBe(0);
    });
  });

  describe('actions reference stability', () => {
    it('actions object should be the same reference across renders when state does not change', () => {
      const { result, rerender } = renderHook(() => useFileTabs('test-wt'));

      const actions1 = result.current[1];
      rerender();
      const actions2 = result.current[1];

      expect(Object.is(actions1, actions2)).toBe(true);
    });

    it('actions object should be the same reference after state changes', () => {
      const { result } = renderHook(() => useFileTabs('test-wt'));

      const actionsBefore = result.current[1];
      act(() => {
        result.current[1].openFile('a.ts');
      });
      const actionsAfter = result.current[1];

      expect(Object.is(actionsBefore, actionsAfter)).toBe(true);
    });

    it('individual action functions should be stable across renders', () => {
      const { result, rerender } = renderHook(() => useFileTabs('test-wt'));

      const openFile1 = result.current[1].openFile;
      rerender();
      const openFile2 = result.current[1].openFile;

      expect(Object.is(openFile1, openFile2)).toBe(true);
    });
  });
});
