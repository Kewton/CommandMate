/**
 * Unit tests for useGitPaneTabState hook (Issue #818)
 *
 * @module tests/unit/hooks/useGitPaneTabState
 * @vitest-environment jsdom
 */

import { renderHook, act, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  useGitPaneTabState,
  GIT_PANE_TABS,
  GIT_PANE_STORAGE_KEYS,
  isGitPaneTab,
} from '@/hooks/useGitPaneTabState';

describe('useGitPaneTabState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  describe('defaults', () => {
    it('defaults to the status tab, history open, advanced closed', async () => {
      const { result } = renderHook(() => useGitPaneTabState());

      await waitFor(() => {
        expect(result.current.activeTab).toBe('status');
        expect(result.current.historyOpen).toBe(true);
        expect(result.current.advancedOpen).toBe(false);
      });
    });

    it('exposes the four tab ids in order', () => {
      expect(GIT_PANE_TABS).toEqual(['status', 'changes', 'history', 'advanced']);
    });

    it('namespaces every key under commandmate:gitPane:', () => {
      expect(GIT_PANE_STORAGE_KEYS.activeTab).toBe('commandmate:gitPane:activeTab');
      expect(GIT_PANE_STORAGE_KEYS.historyOpen).toBe('commandmate:gitPane:historyOpen');
      // Phase 1 (#815) key preserved for backward compatibility.
      expect(GIT_PANE_STORAGE_KEYS.advancedOpen).toBe('commandmate:gitPane:advancedOpen');
    });
  });

  describe('persistence', () => {
    it('persists the active tab to localStorage', async () => {
      const { result } = renderHook(() => useGitPaneTabState());

      act(() => result.current.setActiveTab('history'));

      await waitFor(() => expect(result.current.activeTab).toBe('history'));
      expect(window.localStorage.getItem(GIT_PANE_STORAGE_KEYS.activeTab)).toBe('"history"');
    });

    it('restores the last active tab on a fresh mount', async () => {
      window.localStorage.setItem(GIT_PANE_STORAGE_KEYS.activeTab, '"advanced"');

      const { result } = renderHook(() => useGitPaneTabState());

      await waitFor(() => expect(result.current.activeTab).toBe('advanced'));
    });

    it('falls back to the status tab for an invalid persisted value', async () => {
      window.localStorage.setItem(GIT_PANE_STORAGE_KEYS.activeTab, '"bogus"');

      const { result } = renderHook(() => useGitPaneTabState());

      await waitFor(() => expect(result.current.activeTab).toBe('status'));
    });

    it('toggles and persists the history open state', async () => {
      const { result } = renderHook(() => useGitPaneTabState());
      await waitFor(() => expect(result.current.historyOpen).toBe(true));

      act(() => result.current.toggleHistory());

      await waitFor(() => expect(result.current.historyOpen).toBe(false));
      expect(window.localStorage.getItem(GIT_PANE_STORAGE_KEYS.historyOpen)).toBe('false');
    });

    it('toggles and persists the advanced open state', async () => {
      const { result } = renderHook(() => useGitPaneTabState());
      await waitFor(() => expect(result.current.advancedOpen).toBe(false));

      act(() => result.current.toggleAdvanced());

      await waitFor(() => expect(result.current.advancedOpen).toBe(true));
      expect(window.localStorage.getItem(GIT_PANE_STORAGE_KEYS.advancedOpen)).toBe('true');
    });

    it('reads a pre-existing Phase 1 advancedOpen value (no migration needed)', async () => {
      window.localStorage.setItem(GIT_PANE_STORAGE_KEYS.advancedOpen, 'true');

      const { result } = renderHook(() => useGitPaneTabState());

      await waitFor(() => expect(result.current.advancedOpen).toBe(true));
    });
  });

  describe('isGitPaneTab', () => {
    it('accepts the known tab ids', () => {
      for (const tab of GIT_PANE_TABS) {
        expect(isGitPaneTab(tab)).toBe(true);
      }
    });

    it('rejects unknown / non-string values', () => {
      expect(isGitPaneTab('nope')).toBe(false);
      expect(isGitPaneTab(123)).toBe(false);
      expect(isGitPaneTab(null)).toBe(false);
      expect(isGitPaneTab(undefined)).toBe(false);
    });
  });
});
