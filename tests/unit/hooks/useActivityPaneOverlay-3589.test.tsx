/**
 * useActivityPaneOverlay (Issue #3589): the pin and the overlay's dismissal.
 *
 * The rules pinned here are the Issue's:
 *  - Esc closes from the panel or its toggle — pinned or not — and, while
 *    unpinned, from the page body; never from a field elsewhere (Esc belongs to
 *    the agent CLI there), never when the key's handler called
 *    preventDefault (the file search box), never while a dialog / open menu /
 *    floating layer (the file tree's context menu) is up;
 *  - an outside press closes only while unpinned, and NOT while something in
 *    the panel was edited, NOT when the press is in a portal the panel rendered
 *    (its dialogs / menus), NOT while a dialog or floating layer is open on the
 *    page, and NOT on the panel's own toggle;
 *  - nothing at all while closed (`enabled: false`);
 *  - the pin persists under the key it is given and is read back on mount.
 *
 * @vitest-environment jsdom
 */

import React, { useRef } from 'react';
import { createPortal } from 'react-dom';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, renderHook, act, fireEvent, screen } from '@testing-library/react';
import {
  PaneDirtyContext,
  usePaneDirtyTracker,
  usePaneOverlayDismiss,
  usePanePinnedState,
  useReportPaneDirty,
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
  pinned?: boolean;
  onDismiss: (reason: PaneDismissReason) => void;
  isDirty?: () => boolean | undefined;
  resetKey?: unknown;
}

/** A panel with a field, a portal it renders, a toggle and an outside field. */
function Harness({ enabled = true, pinned, onDismiss, isDirty, resetKey }: HarnessProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const { panelProps } = usePaneOverlayDismiss({
    enabled,
    pinned,
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

/** Append `el` to <body> for the duration of `run`. */
function withElement(el: HTMLElement, run: () => void): void {
  document.body.appendChild(el);
  try {
    run();
  } finally {
    el.remove();
  }
}

function dialogElement(attrs: Record<string, string>): HTMLElement {
  const el = document.createElement('div');
  for (const [name, value] of Object.entries(attrs)) el.setAttribute(name, value);
  return el;
}

describe('usePaneOverlayDismiss — which dialogs hold the pane open (Issue #3589, shared with modal-open)', () => {
  it('still closes while the inline PromptPanel (a question in the terminal) is shown', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const prompt = dialogElement({ role: 'dialog', 'aria-modal': 'true', 'data-testid': 'prompt-panel' });
    withElement(prompt, () => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(onDismiss.mock.calls).toEqual([['outside'], ['escape']]);
  });

  it('still closes while the only dialog sits in a hidden branch (a split behind a maximized one)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const hiddenBranch = document.createElement('div');
    hiddenBranch.hidden = true;
    hiddenBranch.appendChild(dialogElement({ role: 'dialog', 'aria-modal': 'true' }));
    withElement(hiddenBranch, () => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
    });
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('does not close while an open Radix menu is up (negative control)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const menu = dialogElement({ role: 'menu', 'data-state': 'open' });
    withElement(menu, () => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
      fireEvent.keyDown(document.body, { key: 'Escape' });
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('usePaneOverlayDismiss — pinned (Issue #3589)', () => {
  it('closes on Esc pressed in the panel or on its toggle', () => {
    const onDismiss = vi.fn();
    render(<Harness pinned onDismiss={onDismiss} />);
    fireEvent.keyDown(screen.getByTestId('panel-button'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('toggle'), { key: 'Escape' });
    expect(onDismiss.mock.calls).toEqual([['escape'], ['escape']]);
  });

  it('ignores an outside press, an Esc on the page body and an Esc in a field elsewhere', () => {
    const onDismiss = vi.fn();
    render(<Harness pinned onDismiss={onDismiss} />);
    fireEvent.pointerDown(screen.getByTestId('outside'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('outside-input'), { key: 'Escape' });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('leaves an Esc whose own handler called preventDefault alone', () => {
    const onDismiss = vi.fn();
    render(<Harness pinned onDismiss={onDismiss} />);
    const input = screen.getByTestId('panel-input');
    const stop = (event: KeyboardEvent) => event.preventDefault();
    input.addEventListener('keydown', stop);
    fireEvent.keyDown(input, { key: 'Escape' });
    input.removeEventListener('keydown', stop);
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

describe('usePaneOverlayDismiss — a reported dirty state is authoritative (Issue #3589)', () => {
  it('closes on an outside press after an input event when the content reports "not dirty" (saved)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} isDirty={() => false} />);
    fireEvent.input(screen.getByTestId('panel-input'), { target: { value: 'saved' } });
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });

  it('falls back to the input heuristic when the content reports nothing (undefined)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} isDirty={() => undefined} />);
    fireEvent.input(screen.getByTestId('panel-input'), { target: { value: 'x' } });
    fireEvent.pointerDown(screen.getByTestId('outside'));
    expect(onDismiss).not.toHaveBeenCalled();
  });
});

function DirtyReporter({ dirty }: { dirty: boolean }) {
  useReportPaneDirty(dirty);
  return null;
}

describe('useReportPaneDirty / usePaneDirtyTracker (Issue #3589)', () => {
  it('reports the content state to the tracker and withdraws it on unmount', () => {
    let tracker: ReturnType<typeof usePaneDirtyTracker> | null = null;
    function Owner({ dirty, mounted }: { dirty: boolean; mounted: boolean }) {
      tracker = usePaneDirtyTracker();
      return (
        <PaneDirtyContext.Provider value={tracker.reportDirty}>
          {mounted && <DirtyReporter dirty={dirty} />}
        </PaneDirtyContext.Provider>
      );
    }
    const { rerender } = render(<Owner dirty={false} mounted />);
    expect(tracker!.isDirty()).toBe(false);
    rerender(<Owner dirty mounted />);
    expect(tracker!.isDirty()).toBe(true);
    rerender(<Owner dirty mounted={false} />);
    expect(tracker!.isDirty()).toBeUndefined();
  });

  it('does nothing outside a provider', () => {
    expect(() => render(<DirtyReporter dirty />)).not.toThrow();
  });
});

describe('usePaneOverlayDismiss — a floating layer holds the pane open (Issue #3589)', () => {
  it('does not close on an outside press or an Esc while a floating layer (the file tree menu) is open', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const layer = dialogElement({ role: 'menu', 'data-floating-layer': 'open' });
    withElement(layer, () => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
      fireEvent.keyDown(screen.getByTestId('panel-button'), { key: 'Escape' });
    });
    expect(onDismiss).not.toHaveBeenCalled();
  });

  it('closes on an outside press once the layer is gone (negative control)', () => {
    const onDismiss = vi.fn();
    render(<Harness onDismiss={onDismiss} />);
    const layer = dialogElement({ role: 'menu' });
    withElement(layer, () => {
      fireEvent.pointerDown(screen.getByTestId('outside'));
    });
    expect(onDismiss).toHaveBeenCalledWith('outside');
  });
});
