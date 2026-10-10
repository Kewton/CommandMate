/**
 * Whether some modal dialog is already up (Issue #3511).
 *
 * New task does not open over another modal — the `?` help, settings, a
 * confirmation — the same way it stands down while the command palette is
 * open: two focus traps would fight over the keyboard. Every such dialog goes
 * through `Modal` (and so `useFocusTrap`), which renders
 * `role="dialog" aria-modal="true"`; a panel still playing its exit animation
 * (`data-state="closed"`) is already closing and does not count.
 *
 * Read from the DOM rather than from each dialog's context because those
 * dialogs keep their open state in a dozen unrelated places. SSR-safe.
 */

export const OPEN_MODAL_SELECTOR = '[role="dialog"][aria-modal="true"]:not([data-state="closed"])';

export function isAnyModalOpen(): boolean {
  if (typeof document === 'undefined') return false;
  return document.querySelector(OPEN_MODAL_SELECTOR) !== null;
}
