/**
 * Issue #3332: "this split is hidden behind another split's maximize".
 *
 * The container keeps hidden splits mounted under `display: none` (#2261) and
 * is the only one that knows which are hidden. `renderPane` hands its args to a
 * parent-built element (WorktreeDetailDesktop) that assembles the pane's props
 * from a fixed set, so the flag crosses that boundary through context instead.
 */

import { createContext, useContext } from 'react';

const TerminalSplitHiddenContext = createContext(false);

export const TerminalSplitHiddenProvider = TerminalSplitHiddenContext.Provider;

/** `true` while the surrounding split is hidden by a maximize elsewhere. */
export function useTerminalSplitHidden(): boolean {
  return useContext(TerminalSplitHiddenContext);
}
