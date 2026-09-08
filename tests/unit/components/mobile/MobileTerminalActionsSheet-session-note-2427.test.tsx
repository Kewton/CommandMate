/**
 * The session-note row in the phone's terminal actions sheet (Issue #2427).
 *
 * This sheet is rendered by `WorktreeDetailRefactored` BESIDE the terminal tab,
 * so it knows neither the worktree nor the instance a note belongs to. The row
 * therefore takes no callback prop: it raises a window event and
 * `MobileTerminalTab` — which holds both — opens the editor. That is the same
 * escape hatch "Search terminal" already travels, and the two assertions below
 * are what keep the seam honest: the event NAME (the tab listens for exactly
 * this string) and the close (the sheet is modal, so an action that left it open
 * would cover the editor it just opened).
 *
 * The row is unconditional. It is the only way to write a FIRST note on a phone,
 * and a control that appears only once you have used it cannot be discovered —
 * which is why the Issue asks for it to be present even when the note is empty,
 * and why this sheet is deliberately not told whether one exists.
 *
 * next-intl is mocked with the REAL `locales/en/worktree.json`, so the label
 * asserted here is the one a reader sees.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { MobileTerminalActionsSheet } from '@/components/mobile/MobileTerminalActionsSheet';
import { SESSION_NOTE_OPEN_EVENT } from '@/components/worktree/TerminalSplitPane';

const listener = vi.fn();

function renderSheet(overrides: Partial<React.ComponentProps<typeof MobileTerminalActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof MobileTerminalActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    onSearch: vi.fn(),
    onEnd: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<MobileTerminalActionsSheet {...props} />) };
}

describe('MobileTerminalActionsSheet session note (Issue #2427)', () => {
  beforeEach(() => {
    listener.mockClear();
    window.addEventListener(SESSION_NOTE_OPEN_EVENT, listener);
  });

  afterEach(() => {
    window.removeEventListener(SESSION_NOTE_OPEN_EVENT, listener);
  });

  it('offers the note unconditionally — the sheet is never told whether one exists', () => {
    renderSheet();

    const row = screen.getByTestId('actions-sheet-session-note');
    expect(row).toBeInTheDocument();
    expect(row).toHaveTextContent('Session note');
    // The sheet's props carry nothing about a note; nothing here can hide it.
    expect(row).not.toBeDisabled();
  });

  it('raises the intent as the event the terminal tab listens for', () => {
    renderSheet();

    fireEvent.click(screen.getByTestId('actions-sheet-session-note'));

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0][0] as Event).type).toBe(SESSION_NOTE_OPEN_EVENT);
  });

  it('closes the sheet, so the editor it opens is not covered by it', () => {
    const { props } = renderSheet();

    fireEvent.click(screen.getByTestId('actions-sheet-session-note'));

    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('leaves the two pre-#2427 rows exactly as they were', () => {
    const { props } = renderSheet({ endDisabled: true });

    fireEvent.click(screen.getByTestId('actions-sheet-search'));
    expect(props.onSearch).toHaveBeenCalledTimes(1);
    expect(listener).not.toHaveBeenCalled();

    expect(screen.getByTestId('actions-sheet-end')).toBeDisabled();
  });

  it('raises nothing while the sheet is closed', () => {
    renderSheet({ open: false });

    expect(screen.queryByTestId('actions-sheet-session-note')).toBeNull();
    expect(listener).not.toHaveBeenCalled();
  });
});
