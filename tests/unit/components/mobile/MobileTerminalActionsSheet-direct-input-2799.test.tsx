/**
 * The "Direct input" row in the phone's terminal actions sheet (Issue #2799 §1).
 *
 * The entry to the on-screen keyboard. What this file pins:
 *
 *  - the row sits BEFORE "End session", so the destructive action stays last
 *    (and the focus-trap test in `MobileTerminalActionsSheet.test.tsx`, which
 *    takes the DOM's last button as the trap's last stop, stays meaningful);
 *  - it closes the sheet and opens the keyboard, like every other row;
 *  - unavailable, it stays in the list with its reason, `aria-disabled` rather
 *    than `disabled` (so it keeps its place in the focus order and the reason
 *    stays readable), and the tap is refused by the handler too;
 *  - `endDisabled` is untouched.
 *
 * next-intl is the real English dictionary, so the reasons asserted are the
 * ones a reader sees.
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

describe('MobileTerminalActionsSheet direct input (Issue #2799)', () => {
  it('lists search / session note / direct input / end session, in that order', () => {
    renderSheet();
    const sheet = screen.getByTestId('mobile-terminal-actions-sheet');
    const ids = Array.from(sheet.querySelectorAll('button')).map((b) => b.getAttribute('data-testid'));
    expect(ids).toEqual([
      'actions-sheet-search',
      'actions-sheet-session-note',
      'actions-sheet-direct-input',
      'actions-sheet-end',
    ]);
  });

  it('closes the sheet and opens the keyboard when available', () => {
    const order: string[] = [];
    const { props } = renderSheet({
      onClose: vi.fn(() => order.push('close')),
      onDirectInput: vi.fn(() => order.push('open')),
    });
    const row = screen.getByTestId('actions-sheet-direct-input');
    expect(row).toHaveAccessibleName('Direct input');
    expect(row).not.toHaveAttribute('aria-disabled');
    fireEvent.click(row);
    expect(props.onDirectInput).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['close', 'open']);
  });

  const REASONS = [
    ['tab', 'Available on the Terminal tab'],
    ['chat', 'Available in the terminal view (not in chat)'],
    ['session', 'Unavailable: the session is not running'],
  ] as const;

  for (const [reason, text] of REASONS) {
    it(`is unavailable with its reason when ${reason} — aria-disabled, and the tap is refused`, () => {
      const { props } = renderSheet({ directInputUnavailableReason: reason });
      const row = screen.getByTestId('actions-sheet-direct-input');
      expect(row).toHaveAttribute('aria-disabled', 'true');
      // Not `disabled`: it must stay focusable for its reason to be read.
      expect(row).not.toBeDisabled();
      expect(screen.getByTestId('actions-sheet-direct-input-reason')).toHaveTextContent(text);
      expect(row).toHaveAccessibleDescription(text);

      fireEvent.click(row);
      expect(props.onDirectInput).not.toHaveBeenCalled();
      expect(props.onClose).not.toHaveBeenCalled();
    });
  }

  it('leaves End session last and its `disabled` behaviour unchanged', () => {
    renderSheet({ endDisabled: true, directInputUnavailableReason: 'session' });
    const sheet = screen.getByTestId('mobile-terminal-actions-sheet');
    const buttons = Array.from(sheet.querySelectorAll('button'));
    expect(buttons[buttons.length - 1]).toHaveAttribute('data-testid', 'actions-sheet-end');
    expect(screen.getByTestId('actions-sheet-end')).toBeDisabled();
  });

  it('draws no row at all for a caller that does not wire it', () => {
    renderSheet({ onDirectInput: undefined });
    expect(screen.queryByTestId('actions-sheet-direct-input')).not.toBeInTheDocument();
  });
});
