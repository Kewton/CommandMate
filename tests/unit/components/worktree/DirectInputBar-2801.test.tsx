/**
 * The Enter that commits an IME composition never reaches the pane
 * (Issue #2801).
 *
 * Safari before WebKit 310826@main orders the commit as `compositionend` first,
 * then the Enter `keydown` — with `isComposing: false` but `keyCode: 229`. Read
 * by `isComposing` alone, that Enter is a real key: the committed text is sent,
 * and right behind it an Enter that submits the agent's composer or confirms
 * whatever option a dialog has highlighted. Direct input is the mode for
 * screens detection cannot read, so it is the last place a stray Enter may
 * leak.
 *
 * As in the #2766 suite, every case asserts `defaultPrevented` as well as what
 * was sent: the commit Enter belongs to the browser, and cancelling it would be
 * a bug of its own even with nothing posted.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, createEvent, fireEvent } from '@testing-library/react';
import { DirectInputBar } from '@/components/worktree/DirectInputBar';
import type { DirectInputEvent } from '@/types/direct-input';

const hook = vi.hoisted(() => ({ send: vi.fn() }));

vi.mock('@/hooks/useDirectInput', () => ({
  DIRECT_INPUT_ERROR_KEY: 'directInput.error',
  useDirectInput: () => ({ send: hook.send, error: null }),
}));

function renderBar(): HTMLInputElement {
  render(
    <DirectInputBar worktreeId="wt-2801-bar" cliToolId="command-code" onKeysSent={vi.fn()} onClose={vi.fn()} />,
  );
  return screen.getByTestId('direct-input-capture') as HTMLInputElement;
}

function keyDown(input: HTMLElement, init: Record<string, unknown>): Event {
  const event = createEvent.keyDown(input, init);
  fireEvent(input, event);
  return event;
}

/** Every event posted, flattened across `send` calls, in order. */
function sent(): DirectInputEvent[] {
  return hook.send.mock.calls.flatMap((call) => call[0] as DirectInputEvent[]);
}

beforeEach(() => {
  hook.send.mockClear();
});

describe('[#2801] older Safari: compositionend, then the commit Enter', () => {
  it('sends the committed text only, and leaves the Enter to the browser', () => {
    const input = renderBar();

    // The keystrokes of the composition itself ("nihongo" → convert).
    for (const key of ['n', 'i', 'h', 'o', 'n', 'g', 'o', ' ']) {
      keyDown(input, { key, keyCode: 229, isComposing: true });
    }
    input.value = '日本語';
    fireEvent.compositionEnd(input, { data: '日本語' });
    const enter = keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });

    expect(sent()).toEqual([{ type: 'text', text: '日本語' }]);
    expect(enter.defaultPrevented).toBe(false);
    expect(input.value).toBe('');
  });

  it('the fixture really is the old order: the keydown reads isComposing false and keyCode 229', () => {
    // The case above must be green because of `keyCode`, not `isComposing` —
    // otherwise it proves nothing the #2766 suite did not already. Pin both
    // fields as the handler will read them.
    const input = renderBar();
    const enter = createEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false }) as KeyboardEvent;
    expect(enter.isComposing).toBe(false);
    expect(enter.keyCode).toBe(229);
  });

  it('a real Enter after the commit is still sent', () => {
    // 229 marks the IME's key, not "any key after a composition": the user's
    // next, deliberate Enter must still reach the pane.
    const input = renderBar();
    fireEvent.compositionEnd(input, { data: '日本語' });
    keyDown(input, { key: 'Enter', keyCode: 229, isComposing: false });
    const enter = keyDown(input, { key: 'Enter', keyCode: 13 });

    expect(sent()).toEqual([
      { type: 'text', text: '日本語' },
      { type: 'key', key: 'Enter' },
    ]);
    expect(enter.defaultPrevented).toBe(true);
  });
});

describe('[#2801] current order (Chrome, fixed Safari): the commit Enter is composing', () => {
  it('sends the committed text only', () => {
    const input = renderBar();
    const enter = keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true });
    fireEvent.compositionEnd(input, { data: '日本語' });

    expect(sent()).toEqual([{ type: 'text', text: '日本語' }]);
    expect(enter.defaultPrevented).toBe(false);
  });
});
