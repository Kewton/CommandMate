/**
 * Pure helpers for {@link MobileTerminalTab} (Issue #3997). Kept free of React
 * and of the tab's module so they can be tested by their inputs and outputs.
 */

/** What the slot under the terminal region shows for the unsent composer. */
export type MobileUnsentComposerSlot = 'bar' | 'clearNotice' | 'none';

/**
 * Issue #2799: the slot stands down while the direct-input keyboard is open.
 * Issue #3954: the Clear result outlives the bar (a dialog empties composerText),
 * so it is shown alone when the bar is hidden.
 */
export function resolveMobileUnsentComposerSlot(
  showUnsentComposerBar: boolean,
  hasClearNotice: boolean,
  directInputOpen: boolean,
): MobileUnsentComposerSlot {
  if (directInputOpen) return 'none';
  if (showUnsentComposerBar) return 'bar';
  if (hasClearNotice) return 'clearNotice';
  return 'none';
}
