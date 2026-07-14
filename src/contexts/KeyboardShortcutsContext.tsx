/**
 * KeyboardShortcutsContext (Issue #1130)
 *
 * Shares the open/closed state of the global keyboard-shortcuts help overlay
 * (opened by `?`) so that a single overlay instance (mounted in AppShell) can be
 * opened both by the global `?` key and by the command palette's "Keyboard
 * shortcuts" action.
 *
 * The context has a non-throwing default so components remain usable without an
 * explicit provider (e.g. isolated unit tests) — matching CommandPaletteContext.
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

/** Context value for the keyboard-shortcuts overlay open state. */
export interface KeyboardShortcutsContextValue {
  /** Whether the overlay is currently open. */
  open: boolean;
  /** Set the open state explicitly. */
  setOpen: (open: boolean) => void;
  /** Toggle the open state. */
  toggle: () => void;
}

const DEFAULT_CONTEXT_VALUE: KeyboardShortcutsContextValue = {
  open: false,
  setOpen: () => {},
  toggle: () => {},
};

const KeyboardShortcutsContext = createContext<KeyboardShortcutsContextValue>(
  DEFAULT_CONTEXT_VALUE
);

/** Provider that owns the shortcuts-overlay open state. */
export function KeyboardShortcutsProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  const value = useMemo<KeyboardShortcutsContextValue>(
    () => ({ open, setOpen, toggle }),
    [open, toggle]
  );

  return (
    <KeyboardShortcutsContext.Provider value={value}>
      {children}
    </KeyboardShortcutsContext.Provider>
  );
}

/** Access the keyboard-shortcuts overlay open state. */
export function useKeyboardShortcuts(): KeyboardShortcutsContextValue {
  return useContext(KeyboardShortcutsContext);
}
