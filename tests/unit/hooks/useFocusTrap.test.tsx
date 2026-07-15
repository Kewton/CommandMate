/**
 * Tests for useFocusTrap (Issue #1127)
 *
 * Verifies the focus-trap contract used by ui/Modal and the mobile sheets:
 * initial focus into the container, Tab / Shift+Tab cycling, and focus restore
 * to the opener on release.
 *
 * @vitest-environment jsdom
 */

import React, { useState } from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { useFocusTrap } from '@/hooks/useFocusTrap';

function Trap({
  active = true,
  restoreFocus = true,
  initialFocus = true,
}: {
  active?: boolean;
  restoreFocus?: boolean;
  initialFocus?: boolean;
}) {
  const ref = useFocusTrap<HTMLDivElement>({ active, restoreFocus, initialFocus });
  return (
    <div ref={ref} data-testid="trap">
      <button data-testid="first">First</button>
      <button data-testid="middle">Middle</button>
      <button data-testid="last">Last</button>
    </div>
  );
}

function ToggleHarness() {
  const [active, setActive] = useState(false);
  return (
    <div>
      <button data-testid="outside" onClick={() => setActive(true)}>
        Open
      </button>
      {active && (
        <>
          <Trap active />
          <button data-testid="close" onClick={() => setActive(false)}>
            Close
          </button>
        </>
      )}
    </div>
  );
}

describe('useFocusTrap', () => {
  afterEach(() => cleanup());

  it('moves initial focus to the container when engaged', () => {
    render(<Trap />);
    expect(document.activeElement).toBe(screen.getByTestId('trap'));
  });

  it('makes the container programmatically focusable (tabindex=-1)', () => {
    render(<Trap />);
    expect(screen.getByTestId('trap')).toHaveAttribute('tabindex', '-1');
  });

  it('does not steal focus when initialFocus is false', () => {
    render(<Trap initialFocus={false} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('trap'));
  });

  it('wraps focus from the last element to the first on Tab', () => {
    render(<Trap />);
    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');

    last.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('wraps focus from the first element to the last on Shift+Tab', () => {
    render(<Trap />);
    const first = screen.getByTestId('first');
    const last = screen.getByTestId('last');

    first.focus();
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });

    expect(document.activeElement).toBe(last);
  });

  it('pulls focus back inside when Tab is pressed from the container', () => {
    render(<Trap />);
    const container = screen.getByTestId('trap');
    const first = screen.getByTestId('first');

    container.focus();
    fireEvent.keyDown(document, { key: 'Tab' });

    expect(document.activeElement).toBe(first);
  });

  it('does not intercept non-Tab keys', () => {
    render(<Trap />);
    const middle = screen.getByTestId('middle');
    middle.focus();
    fireEvent.keyDown(document, { key: 'ArrowRight' });
    expect(document.activeElement).toBe(middle);
  });

  it('is inert when active is false', () => {
    render(<Trap active={false} />);
    expect(document.activeElement).not.toBe(screen.getByTestId('trap'));
  });

  it('restores focus to the opener when released', () => {
    render(<ToggleHarness />);
    const outside = screen.getByTestId('outside');

    outside.focus();
    expect(document.activeElement).toBe(outside);

    // Open: focus moves into the trap.
    fireEvent.click(outside);
    expect(document.activeElement).toBe(screen.getByTestId('trap'));

    // Close: trap unmounts and focus returns to the opener.
    fireEvent.click(screen.getByTestId('close'));
    expect(document.activeElement).toBe(outside);
  });
});
