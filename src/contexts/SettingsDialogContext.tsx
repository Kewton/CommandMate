/**
 * SettingsDialogContext (Issue #2708)
 *
 * Open/closed state for the one settings modal on PC. Shaped like
 * CommandPaletteContext / AppUpdateContext: a non-throwing default so any
 * component (and any isolated unit test) can call `useSettingsDialog()`
 * without a provider — it simply gets a modal that never opens.
 *
 * The dialog itself is mounted by AppProviders, not by this file: importing
 * the component here would make the module graph a cycle.
 */

'use client';

import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export interface SettingsDialogContextValue {
  /** Whether the settings modal is currently open. */
  isOpen: boolean;
  /** Open it. No-op without a provider. */
  open: () => void;
  /** Close it. No-op without a provider. */
  close: () => void;
}

const noop = (): void => {};

/** Value seen by consumers rendered without SettingsDialogProvider. */
export const SETTINGS_DIALOG_DEFAULT_VALUE: SettingsDialogContextValue = {
  isOpen: false,
  open: noop,
  close: noop,
};

const SettingsDialogContext = createContext<SettingsDialogContextValue>(
  SETTINGS_DIALOG_DEFAULT_VALUE
);

export function SettingsDialogProvider({ children }: { children: ReactNode }) {
  const [isOpen, setIsOpen] = useState(false);
  const open = useCallback(() => setIsOpen(true), []);
  const close = useCallback(() => setIsOpen(false), []);

  const value = useMemo<SettingsDialogContextValue>(
    () => ({ isOpen, open, close }),
    [isOpen, open, close]
  );

  return (
    <SettingsDialogContext.Provider value={value}>
      {children}
    </SettingsDialogContext.Provider>
  );
}

/** App-wide settings-modal state. Outside the provider this never opens. */
export function useSettingsDialog(): SettingsDialogContextValue {
  return useContext(SettingsDialogContext);
}
