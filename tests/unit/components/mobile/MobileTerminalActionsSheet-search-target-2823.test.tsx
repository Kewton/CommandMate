/**
 * The actions sheet's search row follows the surface (Issue #2823).
 *
 * On the phone's chat surface `TerminalDisplay` is not mounted, so "Search
 * terminal" raised an event nobody heard. The row now reads "Search this
 * conversation" there. The sheet only draws the label; which event `onSearch`
 * raises is the caller's (`WorktreeDetailRefactored`, pinned by
 * `WorktreeDetailRefactored-mobile-search-2823.test.tsx`).
 *
 * next-intl is mocked with the REAL `locales/en/worktree.json`, so the labels
 * asserted here are the ones a reader sees.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

import { MobileTerminalActionsSheet } from '@/components/mobile/MobileTerminalActionsSheet';

function renderSheet(overrides: Partial<React.ComponentProps<typeof MobileTerminalActionsSheet>> = {}) {
  const props: React.ComponentProps<typeof MobileTerminalActionsSheet> = {
    open: true,
    onClose: vi.fn(),
    onSearch: vi.fn(),
    onEnd: vi.fn(),
    onDirectInput: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<MobileTerminalActionsSheet {...props} />) };
}

function rowTestIds(): string[] {
  return Array.from(
    screen.getByTestId('mobile-terminal-actions-sheet').querySelectorAll('button'),
  ).map((button) => button.getAttribute('data-testid') ?? '');
}

describe('[#2823] the search row label', () => {
  it('reads "Search terminal" by default and for the terminal surface', () => {
    const { unmount } = renderSheet();
    expect(screen.getByTestId('actions-sheet-search')).toHaveTextContent('Search terminal');
    unmount();

    renderSheet({ searchTarget: 'terminal' });
    expect(screen.getByTestId('actions-sheet-search')).toHaveTextContent('Search terminal');
  });

  it('reads "Search this conversation" for the chat surface', () => {
    renderSheet({ searchTarget: 'chat' });
    const row = screen.getByTestId('actions-sheet-search');
    expect(row).toHaveTextContent('Search this conversation');
    expect(row).not.toHaveTextContent('Search terminal');
  });
});

describe('[#2823] what does not change with the label', () => {
  it('calls onSearch and then closes, whichever surface', () => {
    for (const searchTarget of ['terminal', 'chat'] as const) {
      const { props, unmount } = renderSheet({ searchTarget });
      fireEvent.click(screen.getByTestId('actions-sheet-search'));
      expect(props.onSearch).toHaveBeenCalledTimes(1);
      expect(props.onClose).toHaveBeenCalledTimes(1);
      unmount();
    }
  });

  it('keeps the same rows in the same order (End stays last for the focus trap)', () => {
    const { unmount } = renderSheet();
    const terminalOrder = rowTestIds();
    unmount();

    renderSheet({ searchTarget: 'chat' });
    expect(rowTestIds()).toEqual(terminalOrder);
    expect(terminalOrder).toEqual([
      'actions-sheet-search',
      'actions-sheet-session-note',
      'actions-sheet-direct-input',
      'actions-sheet-end',
    ]);
  });
});
