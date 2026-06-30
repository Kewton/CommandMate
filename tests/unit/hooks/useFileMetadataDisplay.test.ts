/**
 * Tests for useFileMetadataDisplay (Issue #969)
 * @vitest-environment jsdom
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  useFileMetadataDisplay,
  FILE_METADATA_DISPLAY_STORAGE_KEY,
  DEFAULT_FILE_METADATA_DISPLAY,
} from '@/hooks/useFileMetadataDisplay';

describe('useFileMetadataDisplay', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it('defaults to size-only (created/modified hidden inline)', () => {
    const { result } = renderHook(() => useFileMetadataDisplay());
    expect(result.current.settings).toEqual(DEFAULT_FILE_METADATA_DISPLAY);
    expect(result.current.settings).toEqual({
      showSize: true,
      showCreated: false,
      showModified: false,
    });
  });

  it('toggle() flips a single key and persists', () => {
    const { result } = renderHook(() => useFileMetadataDisplay());
    act(() => {
      result.current.toggle('showCreated');
    });
    expect(result.current.settings.showCreated).toBe(true);
    expect(result.current.settings.showSize).toBe(true);

    const stored = JSON.parse(
      window.localStorage.getItem(FILE_METADATA_DISPLAY_STORAGE_KEY)!
    );
    expect(stored.showCreated).toBe(true);

    act(() => {
      result.current.toggle('showCreated');
    });
    expect(result.current.settings.showCreated).toBe(false);
  });

  it('toggle() can hide size and show modified independently', () => {
    const { result } = renderHook(() => useFileMetadataDisplay());
    act(() => {
      result.current.toggle('showSize');
      result.current.toggle('showModified');
    });
    expect(result.current.settings).toEqual({
      showSize: false,
      showCreated: false,
      showModified: true,
    });
  });

  it('setSettings() replaces all settings and persists', () => {
    const { result } = renderHook(() => useFileMetadataDisplay());
    act(() => {
      result.current.setSettings({
        showSize: false,
        showCreated: true,
        showModified: true,
      });
    });
    expect(result.current.settings).toEqual({
      showSize: false,
      showCreated: true,
      showModified: true,
    });
    const stored = JSON.parse(
      window.localStorage.getItem(FILE_METADATA_DISPLAY_STORAGE_KEY)!
    );
    expect(stored).toEqual({
      showSize: false,
      showCreated: true,
      showModified: true,
    });
  });

  it('restores stored settings on mount', () => {
    window.localStorage.setItem(
      FILE_METADATA_DISPLAY_STORAGE_KEY,
      JSON.stringify({ showSize: false, showCreated: true, showModified: false })
    );
    const { result } = renderHook(() => useFileMetadataDisplay());
    expect(result.current.settings).toEqual({
      showSize: false,
      showCreated: true,
      showModified: false,
    });
  });

  it('falls back to defaults when stored value is invalid JSON', () => {
    window.localStorage.setItem(FILE_METADATA_DISPLAY_STORAGE_KEY, 'not-json');
    const { result } = renderHook(() => useFileMetadataDisplay());
    expect(result.current.settings).toEqual(DEFAULT_FILE_METADATA_DISPLAY);
  });

  it('fills missing keys with defaults (partial stored object)', () => {
    window.localStorage.setItem(
      FILE_METADATA_DISPLAY_STORAGE_KEY,
      JSON.stringify({ showCreated: true })
    );
    const { result } = renderHook(() => useFileMetadataDisplay());
    expect(result.current.settings).toEqual({
      showSize: true,
      showCreated: true,
      showModified: false,
    });
  });

  it('syncs state across hook instances on the same page', () => {
    const a = renderHook(() => useFileMetadataDisplay());
    const b = renderHook(() => useFileMetadataDisplay());

    act(() => {
      a.result.current.toggle('showModified');
    });

    expect(a.result.current.settings.showModified).toBe(true);
    expect(b.result.current.settings.showModified).toBe(true);
  });
});
