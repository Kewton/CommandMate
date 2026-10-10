/**
 * Whether some modal dialog is already up (Issue #3511, #3563).
 *
 * New task does not open over another modal — the `?` help, settings, a
 * confirmation — the same way it stands down while the command palette is
 * open: two focus traps would fight over the keyboard.
 *
 * Read from the DOM rather than from each dialog's context because those
 * dialogs keep their open state in a dozen unrelated places. A modal is:
 *
 * - `role="dialog"` with `aria-modal="true"`, not playing its exit animation
 *   (`data-state="closed"` is already closing).
 * - Not the inline `PromptPanel`, which carries both attributes while rendered
 *   in a terminal pane without blocking anything. It is excluded by its
 *   `data-testid`. `tabindex` is no signal: `FullScreenModal` and `FileViewer`
 *   are real modals that render none (Issue #3563).
 * - Displayed: nothing on the way up is `display: none` or `hidden`. A split
 *   hidden behind a maximized one (`TerminalSplitContainer`) stays mounted,
 *   dialogs and all.
 *
 * SSR-safe.
 */

export const OPEN_MODAL_SELECTOR =
  '[role="dialog"][aria-modal="true"]:not([data-state="closed"]):not([data-testid="prompt-panel"])';

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
