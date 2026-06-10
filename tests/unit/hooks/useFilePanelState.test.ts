/**
 * Tests for useFilePanelState (Issue #840)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useFilePanelState,
  FILE_PANEL_COLLAPSED_STORAGE_KEY,
  DEFAULT_FILE_PANEL_COLLAPSED,
} from '@/hooks/useFilePanelState';

describe('useFilePanelState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to collapsed=false (file panel visible)', () => {
    const { result } = renderHook(() => useFilePanelState());
    expect(result.current.collapsed).toBe(DEFAULT_FILE_PANEL_COLLAPSED);
    expect(result.current.collapsed).toBe(false);
  });

  it('toggle() flips collapsed and persists', () => {
    const { result } = renderHook(() => useFilePanelState());
    act(() => {
      result.current.toggle();
    });
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(FILE_PANEL_COLLAPSED_STORAGE_KEY)).toBe('true');
    act(() => {
      result.current.toggle();
    });
    expect(result.current.collapsed).toBe(false);
    expect(window.localStorage.getItem(FILE_PANEL_COLLAPSED_STORAGE_KEY)).toBe('false');
  });

  it('setCollapsed(true) persists', () => {
    const { result } = renderHook(() => useFilePanelState());
    act(() => {
      result.current.setCollapsed(true);
    });
    expect(result.current.collapsed).toBe(true);
    expect(window.localStorage.getItem(FILE_PANEL_COLLAPSED_STORAGE_KEY)).toBe('true');
  });

  it('restores stored collapsed=true on mount', () => {
    window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'true');
    const { result } = renderHook(() => useFilePanelState());
    expect(result.current.collapsed).toBe(true);
  });

  it('restores stored collapsed=false on mount', () => {
    window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'false');
    const { result } = renderHook(() => useFilePanelState());
    expect(result.current.collapsed).toBe(false);
  });

  it('falls back to default when stored value is invalid', () => {
    window.localStorage.setItem(FILE_PANEL_COLLAPSED_STORAGE_KEY, 'garbage');
    const { result } = renderHook(() => useFilePanelState());
    expect(result.current.collapsed).toBe(DEFAULT_FILE_PANEL_COLLAPSED);
  });

  it('syncs state across hook instances on the same page', () => {
    const a = renderHook(() => useFilePanelState());
    const b = renderHook(() => useFilePanelState());

    act(() => {
      a.result.current.toggle();
    });

    expect(a.result.current.collapsed).toBe(true);
    expect(b.result.current.collapsed).toBe(true);
  });
});
