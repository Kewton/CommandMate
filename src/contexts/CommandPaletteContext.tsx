/**
 * CommandPaletteContext (Issue #1053)
 *
 * Shares the open/closed state of the global command palette (⌘K / Ctrl+K) so
 * that a single palette instance (mounted in AppShell) can be opened both by the
 * global keyboard shortcut and by the mobile bottom-nav trigger.
 *
 * The context has a non-throwing default so components remain usable without an
 * explicit provider (e.g. isolated unit tests) — matching PcDisplaySizeContext.
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

/** Context value for the command palette open state. */
export interface CommandPaletteContextValue {
  /** Whether the palette is currently open. */
  open: boolean;
  /** Set the open state explicitly. */
  setOpen: (open: boolean) => void;
  /** Toggle the open state. */
  toggle: () => void;
}

const DEFAULT_CONTEXT_VALUE: CommandPaletteContextValue = {
  open: false,
  setOpen: () => {},
  toggle: () => {},
};

const CommandPaletteContext = createContext<CommandPaletteContextValue>(
  DEFAULT_CONTEXT_VALUE
);

/**
 * Provider that owns the palette open state.
 */
export function CommandPaletteProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);

  const value = useMemo<CommandPaletteContextValue>(
    () => ({ open, setOpen, toggle }),
    [open, toggle]
  );

  return (
    <CommandPaletteContext.Provider value={value}>
      {children}
    </CommandPaletteContext.Provider>
  );
}

/**
 * Access the command palette open state.
 */
export function useCommandPalette(): CommandPaletteContextValue {
  return useContext(CommandPaletteContext);
}
