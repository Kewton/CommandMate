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
 * ## One modal at a time
 *
 * The body lock and the focus are document-wide signals, so they prove THIS
 * panel's effects ran only when no other modal surface is showing. Over an
 * already-open Modal (a ConfirmDialog opened from a dialog), the outer one has
 * locked the body and the inner one's `autoFocus` puts focus inside during the
 * commit: all three conditions hold before the inner Escape listener exists,
 * and an Escape sent then reaches only the outer dialog. Nothing observable on
 * the panel itself marks the inner effects without changing the product, so
 * `waitForModalSettled` refuses that case outright: when any other
 * `[aria-modal="true"]` element (another Modal panel, also one still in its
 * exit window; FullScreenModal; the sheets; the unified file screen) is in the
 * document, it throws instead of resolving. A test that stacks modals has to
 * settle the inner one inside `act()` (open it from a `fireEvent`, or wrap the
 * deferred open in an async `act`), which flushes its effects before returning.
 *
 * It cannot see a body lock with no modal surface behind it (a lock leaked by
 * an earlier test); `isModalSettled` would then be early in the same way.
 *
 * Usage:
 *
 *   fireEvent.click(screen.getByRole('menuitem', { name: 'Settings' }));
 *   await waitForModalSettled();
 *   fireEvent.keyDown(document, { key: 'Escape' });
 */

import { screen, waitFor } from '@testing-library/react';

const PANEL_SELECTOR = '[data-testid="modal-panel"]';

/**
 * True when every passive effect Modal runs on opening has run for `panel` —
 * meaningful only while `panel` is the only modal surface in the document (see
 * "One modal at a time"); `waitForModalSettled` checks that, this does not.
 */
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

/** Other modal surfaces in the document besides `panel` (see "One modal at a time"). */
function otherModalSurfaces(panel: Element): Element[] {
  return Array.from(document.querySelectorAll('[aria-modal="true"]')).filter(
    (element) => element !== panel && !panel.contains(element)
  );
}

function describeSurface(element: Element): string {
  const testId = element.getAttribute('data-testid');
  return testId ? `data-testid="${testId}"` : `<${element.tagName.toLowerCase()}>`;
}

/** Thrown when settling cannot be attributed to one panel. Not retried. */
export class ModalSettledAmbiguousError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModalSettledAmbiguousError';
  }
}

function findPanel(contentTestId: string | undefined): HTMLElement {
  if (contentTestId === undefined) {
    const panels = screen.queryAllByTestId('modal-panel');
    if (panels.length > 1) {
      throw new ModalSettledAmbiguousError(
        `waitForModalSettled is for one modal at a time; ${panels.length} modal panels are in the document`
      );
    }
    return screen.getByTestId('modal-panel');
  }
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
  let ambiguous: ModalSettledAmbiguousError | null = null;
  const panel = await waitFor(() => {
    let found: HTMLElement;
    try {
      found = findPanel(options.contentTestId);
    } catch (error) {
      if (!(error instanceof ModalSettledAmbiguousError)) throw error;
      ambiguous = error;
      return null;
    }
    const others = otherModalSurfaces(found);
    if (others.length > 0) {
      // Stop waiting: the body lock and the focus may be the other surface's,
      // so "settled" would be read too early (the review of #4413).
      ambiguous = new ModalSettledAmbiguousError(
        'waitForModalSettled is for one modal at a time; another modal surface is in the document ' +
          `(${others.map(describeSurface).join(', ')}), so the body lock and the focus cannot prove ` +
          'this panel listens for Escape. Settle a stacked modal inside act() instead.'
      );
      return null;
    }
    const panel = found;
    if (!isModalSettled(panel)) {
      throw new Error(
        `modal panel is in the DOM but not settled yet (data-state=${panel.getAttribute('data-state')}, ` +
          `focus inside=${panel.contains(document.activeElement)}, body overflow=${document.body.style.overflow || '""'})`
      );
    }
    return panel;
  });
  if (ambiguous !== null || panel === null) {
    throw ambiguous ?? new ModalSettledAmbiguousError('waitForModalSettled could not attribute the modal');
  }
  return panel;
}
