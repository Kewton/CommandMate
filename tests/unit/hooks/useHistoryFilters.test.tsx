/**
 * Unit tests for useHistoryFilters (Issue #923).
 *
 * Verifies the History pane filter/display state extracted from
 * useWorktreeDetailController: defaults, localStorage initialization, and that
 * each change handler updates state AND persists to localStorage.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useHistoryFilters } from '@/hooks/useHistoryFilters';
import {
  DEFAULT_MESSAGES_LIMIT,
  HISTORY_DISPLAY_LIMIT_STORAGE_KEY,
  HISTORY_USER_ONLY_STORAGE_KEY,
} from '@/config/history-display-config';

const SHOW_ARCHIVED_KEY = 'commandmate:showArchived';

describe('useHistoryFilters (Issue #923)', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it('defaults when localStorage is empty', () => {
    const { result } = renderHook(() => useHistoryFilters());

    expect(result.current.historySubTab).toBe('message');
    expect(result.current.showArchived).toBe(false);
    expect(result.current.historyUserOnly).toBe(false);
    expect(result.current.historyDisplayLimit).toBe(DEFAULT_MESSAGES_LIMIT);
  });

  it('initializes from localStorage', () => {
    window.localStorage.setItem(SHOW_ARCHIVED_KEY, 'true');
    window.localStorage.setItem(HISTORY_USER_ONLY_STORAGE_KEY, 'true');
    window.localStorage.setItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY, '100');

    const { result } = renderHook(() => useHistoryFilters());

    expect(result.current.showArchived).toBe(true);
    expect(result.current.historyUserOnly).toBe(true);
    expect(result.current.historyDisplayLimit).toBe(100);
  });

  it('falls back to default for an invalid stored display limit', () => {
    window.localStorage.setItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY, '999');

    const { result } = renderHook(() => useHistoryFilters());

    expect(result.current.historyDisplayLimit).toBe(DEFAULT_MESSAGES_LIMIT);
  });

  it('setHistorySubTab updates the sub-tab', () => {
    const { result } = renderHook(() => useHistoryFilters());

    act(() => result.current.setHistorySubTab('git'));

    expect(result.current.historySubTab).toBe('git');
  });

  it('handleShowArchivedChange updates state and persists', () => {
    const { result } = renderHook(() => useHistoryFilters());

    act(() => result.current.handleShowArchivedChange(true));

    expect(result.current.showArchived).toBe(true);
    expect(window.localStorage.getItem(SHOW_ARCHIVED_KEY)).toBe('true');
  });

  it('handleHistoryUserOnlyChange updates state and persists', () => {
    const { result } = renderHook(() => useHistoryFilters());

    act(() => result.current.handleHistoryUserOnlyChange(true));

    expect(result.current.historyUserOnly).toBe(true);
    expect(window.localStorage.getItem(HISTORY_USER_ONLY_STORAGE_KEY)).toBe('true');
  });

  it('handleHistoryDisplayLimitChange updates state and persists', () => {
    const { result } = renderHook(() => useHistoryFilters());

    act(() => result.current.handleHistoryDisplayLimitChange(150));

    expect(result.current.historyDisplayLimit).toBe(150);
    expect(window.localStorage.getItem(HISTORY_DISPLAY_LIMIT_STORAGE_KEY)).toBe('150');
  });

  it('change handlers keep a stable identity across renders', () => {
    const { result, rerender } = renderHook(() => useHistoryFilters());

    const first = result.current.handleShowArchivedChange;
    rerender();
    expect(result.current.handleShowArchivedChange).toBe(first);
  });
});
