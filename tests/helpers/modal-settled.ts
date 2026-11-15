/**
 * Wait until a `ui/Modal` can be closed — not merely until it is in the DOM (Issue #4413).
 *
 * ## Why "in the DOM" is not enough
 *
 * `Modal` (src/components/ui/Modal.tsx) does its work in passive effects: the
 * focus trap moves focus into the panel, the Escape listener goes on
 * `document`, and the body scroll lock is set. A passive effect runs AFTER the
 * commit that puts the panel in the DOM, and for an update React did not start
 * inside `act()` — a modal opened from a timer, a microtask (SettingsMenu's
 * `queueMicrotask(openSettings)`) or a fetch — React's Scheduler runs it in a
 * later macrotask (`setImmediate` under Node).
 *
 * `waitFor` / `findBy*` resolve on the DOM alone, then drain with a 0 ms
 * `setTimeout` before handing control back. When the machine is loaded, the
 * Scheduler's next slice comes after that timer, the test runs on, and an
 * Escape sent now finds no listener: it is lost, the modal stays
 * `data-state="open"` for good, and a focus check passes vacuously because
 * focus never left the opener. That is the CI failure of
 * Sidebar-settings-modal-2709 (#3674 / #3867 / #4413). Waiting longer does not
 * help — the Escape is already gone.
 *
 * ## What "settled" means
 *
 * All of Modal's passive effects for the opening commit have run. They run in
 * one synchronous pass, in declaration order — focus trap, Escape listener,
 * scroll lock — so the last one being visible proves the Escape listener is
 * there:
 *
 * - the panel is `data-state="open"`,
 * - focus is inside the panel (the trap, or a child's `autoFocus`), and
 * - `document.body.style.overflow` is `hidden` (the scroll lock, Modal's last
 *   effect). Focus alone is not proof: a child's `autoFocus` (ConfirmDialog)
 *   puts focus inside during the commit, before any effect.
 *
 * The order is pinned by tests/unit/components/ui/Modal-settled-wait-4413.test.tsx:
 * if Modal's effects are reordered, that test fails rather than this helper
 * silently resolving early.
 *
 * Usage:
 *
 *   fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
 *   await waitForModalSettled();
 *   fireEvent.keyDown(document, { key: 'Escape' });
 */

import { screen, waitFor } from '@testing-library/react';

const PANEL_SELECTOR = '[data-testid="modal-panel"]';

/** True when every passive effect Modal runs on opening has run for `panel`. */
export function isModalSettled(panel: Element): boolean {
  return (
    panel.getAttribute('data-state') === 'open' &&
    panel.contains(document.activeElement) &&
    document.body.style.overflow === 'hidden'
  );
}

export interface WaitForModalSettledOptions {
  /**
   * A test id inside the modal, to pick its panel when the test identifies the
   * dialog by its content. Without it there must be exactly one `modal-panel`.
   */
  contentTestId?: string;
}

function findPanel(contentTestId: string | undefined): HTMLElement {
  if (contentTestId === undefined) return screen.getByTestId('modal-panel');
  const panel = screen.getByTestId(contentTestId).closest<HTMLElement>(PANEL_SELECTOR);
  if (!panel) throw new Error(`"${contentTestId}" is not inside a ui/Modal panel`);
  return panel;
}

/**
 * Resolves with the panel once the modal is open AND settled (see the file
 * header). Uses `waitFor`'s own timeout; it does not lengthen it.
 */
export async function waitForModalSettled(
  options: WaitForModalSettledOptions = {}
): Promise<HTMLElement> {
  return waitFor(() => {
    const panel = findPanel(options.contentTestId);
    if (!isModalSettled(panel)) {
      throw new Error(
        `modal panel is in the DOM but not settled yet (data-state=${panel.getAttribute('data-state')}, ` +
          `focus inside=${panel.contains(document.activeElement)}, body overflow=${document.body.style.overflow || '""'})`
      );
    }
    return panel;
  });
}
