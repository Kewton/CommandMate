/**
 * GitPaneContext (Issue #922)
 *
 * Ambient pane config shared by the extracted GitPane panels so the desktop and
 * mobile layouts no longer prop-drill the same three values through every panel:
 *
 * - `isMobile`: render inline diff / collapse defaults / sticky progress bar.
 * - `onDiffSelect`: PC pushes the selected diff to the right-hand file pane.
 * - `onInsertToMessage`: Issue #817 "Ask AI" — draft a prompt into the composer
 *   (no auto-send). When omitted the "Ask AI" buttons are hidden.
 *
 * The provider value is memoized by the GitPane body so memo'd panels reading
 * this context only re-render when one of the three actually changes.
 */

'use client';

import React, { createContext, useContext } from 'react';

export interface GitPaneContextValue {
  /** When true, panels show diff inline instead of calling onDiffSelect. */
  isMobile: boolean;
  /** Called when a diff is selected (PC: displays in right pane). */
  onDiffSelect: (diff: string, filePath: string) => void;
  /** Issue #817: draft an "Ask AI" prompt into the composer (no auto-send). */
  onInsertToMessage?: (text: string) => void;
}

const GitPaneContext = createContext<GitPaneContextValue | null>(null);

export function GitPaneProvider({
  value,
  children,
}: {
  value: GitPaneContextValue;
  children: React.ReactNode;
}) {
  return <GitPaneContext.Provider value={value}>{children}</GitPaneContext.Provider>;
}

/**
 * Read the ambient GitPane config. Throws when used outside the provider so a
 * mis-wired panel fails loudly instead of silently degrading.
 */
export function useGitPaneContext(): GitPaneContextValue {
  const ctx = useContext(GitPaneContext);
  if (ctx === null) {
    throw new Error('useGitPaneContext must be used within a GitPaneProvider');
  }
  return ctx;
}
