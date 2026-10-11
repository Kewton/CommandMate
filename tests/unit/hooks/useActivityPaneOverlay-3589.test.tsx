/**
 * useActivityPaneOverlay (Issue #3589): the pin and the overlay's dismissal.
 *
 * The rules pinned here are the Issue's:
 *  - Esc closes (from the panel, its toggle or the page body — not from a field
 *    elsewhere, where Esc belongs to the agent CLI);
 *  - an outside press closes, but NOT while something in the panel was edited,
 *    NOT when the press is in a portal the panel rendered (its dialogs / menus),
 *    NOT while a dialog is open on the page, and NOT on the panel's own toggle;
 *  - nothing at all while pinned (`enabled: false`);
 *  - the pin persists under the key it is given and is read back on mount.
 *
 * @vitest-environment jsdom
 */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, fireEvent, screen } from '@testing-library/react';
import {
  usePaneOverlayDismiss,
  usePanePinnedState,
  type PaneDismissReason,
} from '@/hooks/useActivityPaneOverlay';
import { ACTIVITY_PANE_PINNED_STORAGE_KEY } from '@/config/activity-bar-config';

const PIN_KEY = 'commandmate.worktree.activityPanePinned';

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe('usePanePinnedState (Issue #3589)', () => {
  it('stores the activity pane pin under one global key', () => {
    expect(ACTIVITY_PANE_PINNED_STORAGE_KEY).toBe(PIN_KEY);
  });

  it('is not pinned when nothing is stored', () => {
    const { result } = renderHook(() => usePanePinnedState(PIN_KEY));
    expect(result.current.pinned).toBe(false);
    expect(window.localStorage.getItem(PIN_KEY)).toBeNull();
  });

  it('persists a toggle and reads it back on the next mount (a reload)', () => {
    const first = renderHook(() => usePanePinnedState(PIN_KEY));
    act(() => first.result.current.togglePinned());
    expect(first.result.current.pinned).toBe(true);
    expect(window.localStorage.getItem(PIN_KEY)).toBe('true');
    first.unmount();

    const second = renderHook(() => usePanePinnedState(PIN_KEY));
    expect(second.result.current.pinned).toBe(true);

    act(() => second.result.current.togglePinned());
    expect(window.localStorage.getItem(PIN_KEY)).toBe('false');
  });

  it('reads anything other than "true" as not pinned', () => {
    window.localStorage.setItem(PIN_KEY, 'yes');
    const { result } = renderHook(() => usePanePinnedState(PIN_KEY));
    expect(result.current.pinned).toBe(false);
  });
});

interface HarnessProps {
  enabled?: boolean;
  onDismiss: (reason: PaneDismissReason) => void;
  isDirty?: () => boolean;
  resetKey?: unknown;
}

/** A panel with a field, a portal it renders, a toggle and an outside field. */
function Harness({ enabled = true, onDismiss, isDirty, resetKey }: HarnessProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { panelProps } = usePaneOverlayDismiss({
    enabled,
    panelRef,
    onDismiss,
    ignoreSelectors: ['[data-testid="toggle"]'],
    isDirty,
    resetKey,
  });
  return (
    <div>
      <button type="button" data-testid="toggle">toggle</button>
      <div ref={panelRef} data-testid="panel" {...panelProps}>
        <input data-testid="panel-input" defaultValue="" />
        <button type="button" data-testid="panel-button">in panel</button>
        {createPortal(
          <button type="button" data-testid="panel-portal-button">portal</button>,
          document.body,
        )}
      </div>
      <input data-testid="outside-input" />
      <div data-testid="outside">outside</div>
    </div>
  );
}

describe('usePaneOverlayDismiss (Issue #3589)', () => {
  it('closes on a press outside the panel', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('does not close on a press inside the panel', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('panel-button'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not close on a press in a portal the panel rendered (its dialog / menu)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const portalButton = screen.getByTestId('panel-portal-button');
    // Not a DOM descendant of the panel — only the React tree says it is ours.
    expect(screen.getByTestId('panel').contains(portalButton)).toBe(false);
    fireEvent.pointerDown(portalButton);
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not close on a press on the panel toggle (re-click is the toggle’s job)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('toggle'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not close on an outside press after something in the panel was edited', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.input(screen.getByTestId('panel-input'), { target: { value: 'KEY=1' } });
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).not.toHaveBeenCalled();
    // Esc still closes — the Issue keeps Esc / × / re-click unconditional.
    fireEvent.keyDown(screen.getByTestId('panel-input'), { key: 'Escape' });
    expect(onDismiss).toHaveBeenCalledWith('escape');
  });

  it('forgets the edit when the panel shows something else (resetKey)', () => {
    const onDismiss = vi.fn();
    const { rerender } = render(<Harness onDismiss={onDismiss} resetKey="env" />);
    fireEvent.input(screen.getByTestId('panel-input'), { target: { value: 'x' } });
    rerender(<Harness onDismiss={onDismiss} resetKey="files" />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('does not close on an outside press while the caller reports unsaved edits', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} isDirty={() => true} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does not close on an outside press while a dialog is open on the page', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const dialog = document.createElement('div');
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    document.body.appendChild(dialog);
    try {
      fireEvent.pointerDown(screen.getByTestId('outside'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(onDismiss).not.toHaveBeenCalled();
    } finally {
      dialog.remove();
    }
  });

  it('closes on Esc pressed in the panel, on its toggle, or on the page body', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('panel-button'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('toggle'), { key: 'Escape' });
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss.mock.calls).toEqual([['escape'], ['escape'], ['escape']]);
  });

  it('leaves an Esc typed into a field elsewhere (the terminal composer) alone', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('outside-input'), { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('does nothing while disabled (closed or pinned)', () => {
    const onDismiss = vi.fn();
    render(<Harness enabled={false} onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});
