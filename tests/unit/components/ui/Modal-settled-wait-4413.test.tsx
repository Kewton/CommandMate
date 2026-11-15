/**
 * A modal opened outside act() is in the DOM before it listens for Escape (Issue #4413)
 *
 * Sidebar-settings-modal-2709 "returns focus to the menu button" failed on CI
 * three times (#3674, #3867, #4413) with `expected <div data-state="open" …> to
 * be null`. Its modal opens from SettingsMenu's `queueMicrotask(openSettings)`,
 * outside act(), so React's Scheduler commits the panel in one macrotask and
 * runs Modal's passive effects (focus trap, the Escape listener on `document`,
 * the scroll lock) in a later one. `waitFor(panel in the DOM)` can hand control
 * back in between: when the machine is loaded its 0 ms drain timer fires before
 * the Scheduler's next `setImmediate`. The Escape then finds no listener and is
 * lost for good.
 *
 * Load is emulated deterministically: every `setImmediate` (the Scheduler's
 * channel under Node) is pushed 3 ms later, so the Scheduler's next slice
 * always comes after that drain — what a busy CPU does by chance. It must be in
 * place before react-dom's scheduler module reads `setImmediate`, hence
 * `vi.hoisted`; the first test checks that it took effect (the CI failure
 * reproduces), so the file cannot go green on an emulation that did nothing.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';

vi.hoisted(() => {
  const realSetTimeout = globalThis.setTimeout;
  const delayed = (fn: (...args: unknown[]) => void, ...args: unknown[]) =>
    realSetTimeout(() => fn(...args), 3);
  (globalThis as { setImmediate: unknown }).setImmediate = delayed;
});

import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import React, { useState } from 'react';
import { Modal } from '@/components/ui/Modal';
import { EXIT_ANIMATION_DURATION_MS } from '@/config/ui-feedback-config';
import { isModalSettled, ModalSettledAmbiguousError, waitForModalSettled } from '@tests/helpers/modal-settled';

const onClose = vi.fn();

/**
 * An opener whose modal opens a task later, outside act() — the shape of
 * SettingsMenu (Radix's close timer, then a microtask). `deferred={false}`
 * opens it inside the click's act() instead (the ordinary path).
 */
function Host({ autoFocusInside = false, deferred = true }: { autoFocusInside?: boolean; deferred?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        data-testid="opener"
        onClick={() => {
          if (deferred) setTimeout(() => queueMicrotask(() => setOpen(true)), 0);
          else setOpen(true);
        }}
      >
        open
      </button>
      <Modal
        isOpen={open}
        onClose={() => {
          onClose();
          setOpen(false);
        }}
        title="Probe"
      >
        {/* eslint-disable-next-line jsx-a11y/no-autofocus -- ConfirmDialog's shape */}
        <button type="button" autoFocus={autoFocusInside} data-testid="inside">
          inside
        </button>
      </Modal>
    </>
  );
}

function renderAndOpen(props: { autoFocusInside?: boolean; deferred?: boolean } = {}): HTMLElement {
  render(<Host {...props} />);
  const opener = screen.getByTestId('opener');
  act(() => opener.focus());
  fireEvent.click(opener);
  return opener;
}

const outerOnClose = vi.fn();

/**
 * A Modal already open (and settled, inside act()) over which a second one
 * opens a task later, outside act() — a ConfirmDialog raised from a dialog.
 * The inner one's child takes focus itself, as ConfirmDialog's buttons do.
 * The inner Modal is mounted only while open: a closed Modal that mounts after
 * the outer one runs its scroll-lock effect with `isOpen=false` and sets the
 * body back to `unset` (see the commit body), which would hide the overlap.
 */
function StackedHost() {
  const [inner, setInner] = useState(false);
  return (
    <>
      <Modal isOpen onClose={outerOnClose} title="Outer">
        <button
          type="button"
          data-testid="open-inner"
          onClick={() => setTimeout(() => queueMicrotask(() => setInner(true)), 0)}
        >
          open inner
        </button>
      </Modal>
      {inner && (
        <Modal
          isOpen
          onClose={() => {
            onClose();
            setInner(false);
          }}
          title="Inner"
          size="sm"
        >
          {/* eslint-disable-next-line jsx-a11y/no-autofocus -- ConfirmDialog's shape */}
          <button type="button" autoFocus data-testid="inner-confirm">
            confirm
          </button>
        </Modal>
      )}
    </>
  );
}

/**
 * Resolves in the microtask right after the commit that inserts the panel
 * (the one holding `contentTestId`, when given).
 */
function atPanelCommit<T>(read: (panel: HTMLElement) => T, contentTestId?: string): Promise<T> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const panel = contentTestId
        ? document
            .querySelector(`[data-testid="${contentTestId}"]`)
            ?.closest<HTMLElement>('[data-testid="modal-panel"]')
        : document.querySelector<HTMLElement>('[data-testid="modal-panel"]');
      if (!panel) return;
      observer.disconnect();
      resolve(read(panel));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

afterEach(() => {
  onClose.mockClear();
  outerOnClose.mockClear();
});

describe('Modal opened outside act() under load (Issue #4413)', () => {
  it('positive control: waiting for the panel alone loses the Escape — the CI failure', async () => {
    expect(String(globalThis.setImmediate)).toContain('realSetTimeout');
    const opener = renderAndOpen();

    // The wait the three earlier fixes kept.
    await waitFor(() => expect(screen.getByTestId('modal-panel')).toBeInTheDocument());
    const focusStillOnOpener = document.activeElement === opener;
    fireEvent.keyDown(document, { key: 'Escape' });

    // Well past the exit window: a handled Escape would have unmounted it.
    await new Promise((resolve) => setTimeout(resolve, EXIT_ANIMATION_DURATION_MS * 2));
    expect(focusStillOnOpener).toBe(true); // so "focus is back on the opener" passed vacuously
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('modal-panel')).toHaveAttribute('data-state', 'open');
  });

  it.each([
    ['the focus trap', false],
    ['a child autoFocus (ConfirmDialog)', true],
  ])('is not settled at the commit that inserts the panel (%s)', async (_name, autoFocusInside) => {
    const commit = atPanelCommit((panel) => ({
      inDom: document.body.contains(panel),
      focusInside: panel.contains(document.activeElement),
      settled: isModalSettled(panel),
    }));
    renderAndOpen({ autoFocusInside });
    const seen = await commit;

    expect(seen.inDom).toBe(true);
    // With autoFocus the focus is inside already, before any effect: focus alone is no proof.
    expect(seen.focusInside).toBe(autoFocusInside);
    expect(seen.settled).toBe(false);
  });

  it('waitForModalSettled holds the Escape until Modal listens; focus goes back to the opener', async () => {
    const opener = renderAndOpen();

    const panel = await waitForModalSettled();
    expect(document.activeElement).toBe(panel);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await waitFor(() => expect(screen.queryByTestId('modal-panel')).toBeNull());
  });

  it('waitForModalSettled also covers a modal whose child takes focus itself', async () => {
    renderAndOpen({ autoFocusInside: true });

    await waitForModalSettled({ contentTestId: 'inside' });
    expect(document.activeElement).toBe(screen.getByTestId('inside'));
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('modal-panel')).toBeNull());
  });

  it('negative control: a modal opened inside act() is settled at once and closes as before', async () => {
    const opener = renderAndOpen({ deferred: false });

    expect(isModalSettled(screen.getByTestId('modal-panel'))).toBe(true);
    await waitForModalSettled();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(document.activeElement).toBe(opener));
    await waitFor(() => expect(screen.queryByTestId('modal-panel')).toBeNull());
  });
});

describe('a modal opened over another one (review of #4413)', () => {
  function renderStackedAndOpenInner(): void {
    render(<StackedHost />);
    // The outer Modal opened inside render's act(), so it is settled already.
    expect(isModalSettled(screen.getByTestId('open-inner').closest('[data-testid="modal-panel"]')!)).toBe(true);
    fireEvent.click(screen.getByTestId('open-inner'));
  }

  it('positive control: the three signals already hold at the inner commit, and an Escape then reaches only the outer one', async () => {
    const commit = atPanelCommit((panel) => {
      const settled = isModalSettled(panel);
      fireEvent.keyDown(document, { key: 'Escape' });
      return settled;
    }, 'inner-confirm');
    renderStackedAndOpenInner();

    // The outer lock and the inner autoFocus make the inner look settled
    // before its own effects ran — the helper before this fix resolved here.
    expect(await commit).toBe(true);
    expect(outerOnClose).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('waitForModalSettled refuses it instead of resolving early', async () => {
    renderStackedAndOpenInner();

    await expect(waitForModalSettled({ contentTestId: 'inner-confirm' })).rejects.toBeInstanceOf(
      ModalSettledAmbiguousError,
    );
    await expect(waitForModalSettled()).rejects.toThrow(/one modal at a time/);
    expect(outerOnClose).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  // Only that the inner listener is there: the outer Modal registered its own
  // listener earlier and hears the same Escape — stacked Modals are not this
  // issue's to change (see the commit body).
  it('the way it points to: settled inside act(), the inner Modal hears the Escape', async () => {
    render(<StackedHost />);
    await act(async () => {
      fireEvent.click(screen.getByTestId('open-inner'));
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(screen.getByTestId('inner-confirm')).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
