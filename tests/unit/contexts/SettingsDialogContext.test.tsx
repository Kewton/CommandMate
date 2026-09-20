/**
 * SettingsDialogContext (Issue #2708).
 *
 * The context is deliberately shaped like CommandPaletteContext /
 * AppUpdateContext: consumers outside the provider get a no-op value instead
 * of a throw, so a component that offers a "Settings" trigger can be unit
 * tested in isolation without wrapping it. What is worth pinning here is that
 * contract (no throw, never opens) plus the identity stability of `open` /
 * `close`, because #2709 will hang them off memoised triggers.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect } from 'vitest';
import { act, renderHook } from '@testing-library/react';

import {
  SETTINGS_DIALOG_DEFAULT_VALUE,
  SettingsDialogProvider,
  useSettingsDialog,
} from '@/contexts/SettingsDialogContext';

function wrapper({ children }: { children: React.ReactNode }) {
  return <SettingsDialogProvider>{children}</SettingsDialogProvider>;
}

describe('SettingsDialogContext', () => {
  describe('without a provider', () => {
    it('returns the closed default instead of throwing', () => {
      const { result } = renderHook(() => useSettingsDialog());

      expect(result.current.isOpen).toBe(false);
      expect(result.current).toBe(SETTINGS_DIALOG_DEFAULT_VALUE);
    });

    it('treats open() as a no-op that leaves the modal closed', () => {
      const { result } = renderHook(() => useSettingsDialog());

      expect(() => act(() => result.current.open())).not.toThrow();
      expect(result.current.isOpen).toBe(false);

      expect(() => act(() => result.current.close())).not.toThrow();
      expect(result.current.isOpen).toBe(false);
    });
  });

  describe('with a provider', () => {
    it('starts closed', () => {
      const { result } = renderHook(() => useSettingsDialog(), { wrapper });

      expect(result.current.isOpen).toBe(false);
    });

    it('opens on open() and closes on close()', () => {
      const { result } = renderHook(() => useSettingsDialog(), { wrapper });

      act(() => result.current.open());
      expect(result.current.isOpen).toBe(true);

      act(() => result.current.close());
      expect(result.current.isOpen).toBe(false);
    });

    it('stays open when open() is called twice', () => {
      const { result } = renderHook(() => useSettingsDialog(), { wrapper });

      act(() => result.current.open());
      act(() => result.current.open());

      expect(result.current.isOpen).toBe(true);
    });

    it('keeps open/close referentially stable across re-renders and state changes', () => {
      const { result, rerender } = renderHook(() => useSettingsDialog(), { wrapper });
      const { open, close } = result.current;

      rerender();
      expect(result.current.open).toBe(open);
      expect(result.current.close).toBe(close);

      // Toggling state re-creates the context value object, but the callbacks
      // have empty dependency lists and must survive it.
      act(() => result.current.open());
      expect(result.current.open).toBe(open);
      expect(result.current.close).toBe(close);
    });
  });
});
