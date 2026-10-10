/**
 * Whether some modal dialog is already up (Issue #3511).
 *
 * New task does not open over another modal — the `?` help, settings, a
 * confirmation — the same way it stands down while the command palette is
 * open: two focus traps would fight over the keyboard.
 *
 * Read from the DOM rather than from each dialog's context because those
 * dialogs keep their open state in a dozen unrelated places. Only a real modal
 * counts, which takes three things:
 *
 * - `role="dialog"` with `aria-modal="true"`, not playing its exit animation
 *   (`data-state="closed"` is already closing).
 * - A focus trap: `Modal` renders its panel with `tabindex="-1"`, and
 *   `useFocusTrap` gives its container one when it engages (the mobile sheets).
 *   `role="dialog" aria-modal` alone is not enough — `PromptPanel` carries both
 *   while rendered inline in a terminal pane, without trapping anything.
 * - Being displayed: nothing on the way up is `display: none` or `hidden`. A
 *   split hidden behind a maximized one (`TerminalSplitContainer`) stays
 *   mounted, dialogs and all.
 *
 * SSR-safe.
 */

export const OPEN_MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"][tabindex]:not([data-state="closed"])';

/** Whether `element` and every ancestor are displayed. */
export function isDisplayed(element: Element): boolean {
  const view = element.ownerDocument.defaultView;
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (node instanceof HTMLElement && node.hidden) return false;
    if (view && view.getComputedStyle(node).display === 'none') return false;
  }
  return true;
}

export function isAnyModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return Array.from(document.querySelectorAll(OPEN_MODAL_SELECTOR)).some(isDisplayed);
}
