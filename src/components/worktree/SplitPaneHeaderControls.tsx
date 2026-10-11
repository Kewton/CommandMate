/**
 * Where a split's header controls are drawn (Issue #3592).
 *
 * With ONE split open, the split's own title bar is a second band of controls
 * stacked under the action bar — 30-odd pixels of terminal height spent on a
 * row that names the only session on screen. So the action bar (the worktree
 * screen's second row, `TerminalSplitContainer`) offers two slots and the lone
 * split draws its header controls into them instead:
 *  - `session`: the agent selector, Terminal / Chat, model, cost, the session
 *    note (or its edit entry) and End — right of the Verification chip;
 *  - `actions`: search and "…" — at the right end, left of History /
 *    Open Files. Not the split's maximize icon: the bar has its own
 *    (`toggle-maximize-split`), and the "…" menu keeps the item.
 * With two or more splits there are no slots and every split keeps its own
 * (30px) title bar, so which split a control acts on stays visible.
 *
 * The controls are PORTALLED into the slots, not lifted out of the pane: the
 * pane stays where it is in the React tree, so switching between one and two
 * splits moves only the controls and never re-creates the split's content (the
 * composer draft, the polling, the scroll position, the Verification reason).
 * React events still bubble through the pane, so a press in the slot focuses
 * the split as a press in its title bar does; the DOM does not, so what the
 * split draws there is wrapped in a `data-split-index` box — the split's own
 * shortcuts find their owner through it.
 *
 * The context lives here rather than in either component so that neither
 * `TerminalSplitPane` nor `TerminalSplitContainer` has to import the other.
 *
 * @module components/worktree/SplitPaneHeaderControls
 */

'use client';

import { createContext, useContext } from 'react';

/** The action bar's two slots a lone split's header controls move into. */
export interface SplitHeaderSlots {
  /** Right of the Verification chip: selector, Terminal / Chat, labels, note. */
  session: HTMLElement;
  /** Right end, left of History / Open Files: search, "…". */
  actions: HTMLElement;
}

/**
 * Null (the default, and whenever two or more splits are open) means "draw
 * the title bar in the split", which is also what every caller without a
 * container above it — the pane's own tests, the phone — gets.
 */
const SplitHeaderSlotsContext = createContext<SplitHeaderSlots | null>(null);

export const SplitHeaderSlotsProvider = SplitHeaderSlotsContext.Provider;

/** The slots this split's header controls should be portalled into, or null. */
export function useSplitHeaderSlots(): SplitHeaderSlots | null {
  return useContext(SplitHeaderSlotsContext);
}
