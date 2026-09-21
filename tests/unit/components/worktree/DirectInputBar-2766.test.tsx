/**
 * `DirectInputBar` encodes what was typed, and leaves the rest to the browser
 * (Issue #2766).
 *
 * There are two ways to get this component wrong and only one of them looks
 * like a bug in the pane:
 *
 *  1. it fails to send a key the user pressed — visible immediately;
 *  2. it *swallows* a key the browser needed. `preventDefault()` on Cmd+C, on
 *     F5, or on a keystroke that belongs to an IME composition costs the user
 *     copy/paste, reload and the ability to type Japanese at all, and none of
 *     that shows up as an error anywhere.
 *
 * `encodeKeyEvent` already draws that line by returning `null`, so the whole
 * job here is to honour it: **`null` means no send AND no `preventDefault`**.
 * Every case below therefore asserts `defaultPrevented` as well as the payload
 * — the payload alone is green under a component that cancels everything.
 *
 * The transport is stubbed (`useDirectInput` has its own suite): what is under
 * test is the translation from DOM event to `DirectInputEvent[]`.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, createEvent, fireEvent } from '@testing-library/react';
import { DirectInputBar } from '@/components/worktree/DirectInputBar';
import { DIRECT_INPUT_ERROR_KEY } from '@/hooks/useDirectInput';
import { MAX_DIRECT_INPUT_TEXT_LENGTH, type DirectInputEvent } from '@/types/direct-input';

const hook = vi.hoisted(() => ({
  send: vi.fn(),
  error: null as string | null,
  args: [] as unknown[][],
}));

vi.mock('@/hooks/useDirectInput', () => ({
  DIRECT_INPUT_ERROR_KEY: 'directInput.error',
  useDirectInput: (...args: unknown[]) => {
    hook.args.push(args);
    return { send: hook.send, error: hook.error };
  },
}));

const WORKTREE_ID = 'wt-2766-bar';

function renderBar(overrides: { onClose?: () => void; instanceId?: string } = {}) {
  const onClose = overrides.onClose ?? vi.fn();
  const utils = render(
    <DirectInputBar
      worktreeId={WORKTREE_ID}
      cliToolId="command-code"
      instanceId={overrides.instanceId}
      onKeysSent={vi.fn()}
      onClose={onClose}
    />,
  );
  return { ...utils, onClose, input: screen.getByTestId('direct-input-capture') as HTMLInputElement };
}

/** Dispatch a keydown built by hand, so `defaultPrevented` can be read back. */
function keyDown(input: HTMLElement, init: Record<string, unknown>): Event {
  const event = createEvent.keyDown(input, init);
  fireEvent(input, event);
  return event;
}

/** The single argument of the single `send` call, or `null` when none was made. */
function sentOnce(): DirectInputEvent[] | null {
  if (hook.send.mock.calls.length === 0) return null;
  expect(hook.send).toHaveBeenCalledTimes(1);
  return hook.send.mock.calls[0][0] as DirectInputEvent[];
}

beforeEach(() => {
  hook.send.mockClear();
  hook.args.length = 0;
  hook.error = null;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('[#2766] keys the bar owns', () => {
  it.each([
    ['a printable character', { key: 'a' }, [{ type: 'text', text: 'a' }]],
    ['a semicolon', { key: ';' }, [{ type: 'text', text: ';' }]],
    ['Ctrl+A', { key: 'a', ctrlKey: true }, [{ type: 'key', key: 'C-a' }]],
    ['ArrowUp', { key: 'ArrowUp' }, [{ type: 'key', key: 'Up' }]],
    ['Shift+Tab', { key: 'Tab', shiftKey: true }, [{ type: 'key', key: 'BTab' }]],
    ['Enter', { key: 'Enter' }, [{ type: 'key', key: 'Enter' }]],
  ])('sends %s and cancels the browser default', (_label, init, expected) => {
    const { input } = renderBar();
    const event = keyDown(input, init);
    expect(sentOnce()).toEqual(expected);
    expect(event.defaultPrevented).toBe(true);
  });

  it('sends Escape rather than using it to leave the mode', () => {
    // The mode exists to reach overlays nothing else can drive, and Esc is the
    // most useful key to send to one. Closing on Esc would make direct input
    // unable to send the key it was built for.
    const { input, onClose } = renderBar();
    const event = keyDown(input, { key: 'Escape' });

    expect(sentOnce()).toEqual([{ type: 'key', key: 'Escape' }]);
    expect(event.defaultPrevented).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByTestId('direct-input-bar')).toBeInTheDocument();
  });
});

describe('[#2766] keys the browser keeps', () => {
  it.each([
    ['Cmd+C', { key: 'c', metaKey: true }],
    ['Cmd+V', { key: 'v', metaKey: true }],
    ['Cmd+R', { key: 'r', metaKey: true }],
    ['F5', { key: 'F5' }],
    ['an IME keystroke', { key: 'a', isComposing: true }],
    ['a bare modifier', { key: 'Shift', shiftKey: true }],
  ])('leaves %s alone: nothing sent, nothing cancelled', (_label, init) => {
    const { input } = renderBar();
    const event = keyDown(input, init);
    expect(hook.send).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('[#2766] IME', () => {
  it('sends the committed string once and empties the field', () => {
    const { input } = renderBar();

    // The composition itself was never cancelled (above), so the candidate text
    // is sitting in the field when it commits.
    input.value = 'あ';
    fireEvent.compositionEnd(input, { data: 'あ' });

    expect(sentOnce()).toEqual([{ type: 'text', text: 'あ' }]);
    expect(input.value).toBe('');
  });

  it('sends nothing for a composition that committed no text', () => {
    const { input } = renderBar();
    fireEvent.compositionEnd(input, { data: '' });
    expect(hook.send).not.toHaveBeenCalled();
    expect(input.value).toBe('');
  });
});

describe('[#2766] paste', () => {
  function paste(input: HTMLElement, text: string): Event {
    const event = createEvent.paste(input);
    Object.defineProperty(event, 'clipboardData', {
      value: { getData: (type: string) => (type === 'text' ? text : '') },
    });
    fireEvent(input, event);
    return event;
  }

  it('normalises newlines to CR and cancels the browser paste', () => {
    // `\n` is a line feed: in a shell or a TUI composer it moves the cursor
    // down without submitting. Enter is CR, and a pasted script that does not
    // run is the bug this line prevents.
    const { input } = renderBar();
    const event = paste(input, 'a\nb\r\nc');

    expect(sentOnce()).toEqual([{ type: 'text', text: 'a\rb\rc' }]);
    expect(event.defaultPrevented).toBe(true);
    expect(input.value).toBe('');
  });

  it('splits a paste longer than one event may carry', () => {
    const { input } = renderBar();
    const text = 'x'.repeat(MAX_DIRECT_INPUT_TEXT_LENGTH + 1);
    paste(input, text);

    const events = sentOnce();
    expect(events).toHaveLength(2);
    expect(events?.[0]).toEqual({ type: 'text', text: 'x'.repeat(MAX_DIRECT_INPUT_TEXT_LENGTH) });
    expect(events?.[1]).toEqual({ type: 'text', text: 'x' });
    expect(events?.map((e) => (e.type === 'text' ? e.text : '')).join('')).toBe(text);
  });

  it('sends nothing for an empty clipboard, and still cancels', () => {
    const { input } = renderBar();
    const event = paste(input, '');
    expect(hook.send).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(true);
  });
});

describe('[#2766] the bar itself', () => {
  it('targets the worktree, tool and instance it was given', () => {
    renderBar({ instanceId: 'command-code-2' });
    expect(hook.args[0].slice(0, 3)).toEqual([WORKTREE_ID, 'command-code', 'command-code-2']);
  });

  it('takes focus on mount and starts empty', () => {
    const { input } = renderBar();
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('');
    expect(input).toHaveAttribute('autocomplete', 'off');
    expect(input).toHaveAttribute('spellcheck', 'false');
  });

  it('leaves the mode from the close button', () => {
    const onClose = vi.fn();
    renderBar({ onClose });
    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('announces a failure and says nothing when there is none', () => {
    const { unmount } = renderBar();
    expect(screen.queryByRole('alert')).toBeNull();
    unmount();

    hook.error = DIRECT_INPUT_ERROR_KEY;
    renderBar();
    expect(screen.getByRole('alert')).toHaveTextContent('directInput.error');
  });
});
