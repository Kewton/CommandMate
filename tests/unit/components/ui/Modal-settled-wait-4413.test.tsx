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
import { isModalSettled, waitForModalSettled } from '@tests/helpers/modal-settled';

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

/** Resolves in the microtask right after the commit that inserts the panel. */
function atPanelCommit<T>(read: (panel: HTMLElement) => T): Promise<T> {
  return new Promise((resolve) => {
    const observer = new MutationObserver(() => {
      const panel = document.querySelector<HTMLElement>('[data-testid="modal-panel"]');
      if (!panel) return;
      observer.disconnect();
      resolve(read(panel));
    });
    observer.observe(document.body, { childList: true, subtree: true });
  });
}

afterEach(() => {
  onClose.mockClear();
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
