/**
 * The phone's direct-input keyboard (Issue #2799), one acceptance criterion at
 * a time.
 *
 * The component runs on the REAL `useDirectInput` over a `fetch` the test
 * settles by hand, so "a tap sends nothing" and "送信 is one request, in order"
 * are observed at the network boundary rather than at a mocked hook. next-intl
 * is the real Japanese dictionary, so every label this keyboard asks for has to
 * exist (the helper throws on a missing key) and `送信 (N)` is asserted as the
 * user reads it.
 *
 * Keys are driven with pointer events — the keyboard acts on `pointerup`, as
 * Termux acts on `ACTION_UP` — and every key's rect is stubbed to a real box so
 * "released inside / outside the key" and the 24px swipe are meaningful.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render, screen, within } from '@testing-library/react';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('ja');
});

import { MobileDirectInputKeyboard } from '@/components/mobile/MobileDirectInputKeyboard';
import {
  DIRECT_INPUT_LONG_PRESS_MS,
  DIRECT_INPUT_REPEAT_INTERVAL_MS,
  charKeyTestId,
} from '@/config/mobile-keyboard-layout';
import { MAX_DIRECT_INPUT_EVENTS, type DirectInputEvent } from '@/types/direct-input';

const WORKTREE_ID = 'wt-2799-kbd';

/** Every key's box: 50 x 44 at (0, 100). The swipe and the in/out test read it. */
const KEY_RECT = { left: 0, top: 100, right: 50, bottom: 144, width: 50, height: 44, x: 0, y: 100 };
const INSIDE = { clientX: 25, clientY: 122 };
const OUTSIDE = { clientX: 80, clientY: 122 };

interface PendingCall {
  body: { cliToolId: string; events: DirectInputEvent[]; instanceId?: string };
  settle: (ok?: boolean) => void;
}
let calls: PendingCall[] = [];

beforeEach(() => {
  calls = [];
  global.fetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
    let settle!: PendingCall['settle'];
    const promise = new Promise<Response>((resolve) => {
      settle = (ok = true) => resolve({ ok, status: ok ? 200 : 500, json: async () => ({}) } as Response);
    });
    calls.push({ body: JSON.parse(String(init?.body ?? '{}')), settle });
    return promise;
  }) as unknown as typeof fetch;
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    ...KEY_RECT,
    toJSON: () => KEY_RECT,
  } as DOMRect);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderKeyboard(overrides: Partial<React.ComponentProps<typeof MobileDirectInputKeyboard>> = {}) {
  const props = {
    worktreeId: WORKTREE_ID,
    cliToolId: 'claude' as const,
    onClose: vi.fn(),
    onKeysSent: vi.fn(),
    ...overrides,
  };
  return { props, ...render(<MobileDirectInputKeyboard {...props} />) };
}

function key(id: string): HTMLElement {
  return screen.getByTestId(`direct-key-${id}`);
}

function charKey(char: string): HTMLElement {
  return screen.getByTestId(charKeyTestId(char));
}

/** A tap: down and up inside the key, as the finger does it. */
function tap(el: HTMLElement): void {
  fireEvent.pointerDown(el, { pointerId: 1, ...INSIDE });
  fireEvent.pointerUp(el, { pointerId: 1, ...INSIDE });
}

function typeText(chars: string): void {
  for (const char of chars) tap(charKey(char));
}

function openChars(): void {
  if (!screen.queryByTestId('direct-input-char-panel')) {
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
  }
}

function chips(): string[] {
  return screen.queryAllByTestId('direct-input-chip').map((chip) => chip.textContent ?? '');
}

function sendButton(): HTMLElement {
  return screen.getByTestId('direct-input-send');
}

function isDisabled(el: HTMLElement): boolean {
  return el.getAttribute('aria-disabled') === 'true';
}

describe('[#2799 §2 / §10] structure', () => {
  it('is a labelled group with a confirm row and two rows of seven special keys; letters folded', () => {
    renderKeyboard();
    const root = screen.getByRole('group', { name: '直接入力キーボード' });
    expect(root).toHaveAttribute('data-testid', 'mobile-direct-input-keyboard');
    expect(within(root).getByRole('group', { name: '送るキーの確認' })).toBeInTheDocument();
    const special = within(root).getByRole('group', { name: '特殊キー' });
    expect(within(special).getAllByRole('button')).toHaveLength(14);
    // The character panel starts folded (§2: 132px, not 308px).
    expect(screen.queryByTestId('direct-input-char-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('direct-input-toggle-chars')).toHaveAttribute('aria-expanded', 'false');
  });

  it('opens the character panel from ABC, on the letters page', () => {
    renderKeyboard();
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
    const panel = screen.getByRole('group', { name: '文字キー' });
    expect(panel).toHaveAttribute('data-page', 'alpha');
    expect(screen.getByTestId('direct-input-toggle-chars')).toHaveAttribute('aria-expanded', 'true');
    expect(within(panel).getAllByRole('button')).toHaveLength(36);
  });

  it('holds no input element at all, so no tap can raise the OS keyboard', () => {
    const { container } = renderKeyboard();
    openChars();
    expect(container.querySelectorAll('input, textarea, select, [contenteditable]')).toHaveLength(0);
    for (const button of container.querySelectorAll('button')) {
      expect(button).toHaveAttribute('type', 'button');
    }
  });

  it('names symbol keys through aria-label and announces the count politely', () => {
    renderKeyboard();
    expect(key('up')).toHaveAttribute('aria-label', '上矢印');
    expect(key('bs')).toHaveAttribute('aria-label', 'Backspace キー（上へスワイプで Delete）');
    expect(screen.getByTestId('direct-input-clear')).toHaveAttribute('aria-label', 'すべて消去');
    const count = screen.getByTestId('direct-input-count');
    expect(count).toHaveAttribute('aria-live', 'polite');
    expect(count).toHaveTextContent('送る予定 0 件');
    // The chips are not a live region: a tap must not read the list back.
    expect(screen.getByTestId('direct-input-chips')).not.toHaveAttribute('aria-live');
  });

  it('blurs whatever had focus when it mounts (the OS keyboard closes)', () => {
    const textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.focus();
    expect(document.activeElement).toBe(textarea);
    renderKeyboard();
    expect(document.activeElement).not.toBe(textarea);
    textarea.remove();
  });

  it('prevents the default of pointerdown so a tap never moves focus', () => {
    renderKeyboard();
    const notCancelled = fireEvent.pointerDown(key('esc'), { pointerId: 1, ...INSIDE });
    expect(notCancelled).toBe(false);
    fireEvent.pointerUp(key('esc'), { pointerId: 1, ...INSIDE });
  });
});

describe('[#2799 §3] special keys stage their vocabulary key', () => {
  const CASES: Array<[string, string]> = [
    ['esc', 'Escape'], ['enter', 'Enter'], ['bs', 'BSpace'], ['home', 'Home'], ['up', 'Up'],
    ['end', 'End'], ['pgup', 'PageUp'], ['tab', 'Tab'], ['left', 'Left'], ['down', 'Down'],
    ['right', 'Right'], ['pgdn', 'PageDown'],
  ];

  it('stages each key in order and sends them as ONE request on 送信', async () => {
    renderKeyboard();
    for (const [id] of CASES) tap(key(id));
    // Staged, not sent.
    expect(calls).toHaveLength(0);
    expect(sendButton()).toHaveTextContent(`送信 (${CASES.length})`);

    fireEvent.click(sendButton());
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({
      cliToolId: 'claude',
      events: CASES.map(([, k]) => ({ type: 'key', key: k })),
    });
    await act(async () => calls[0].settle());
  });

  it('stages DEL for an upward swipe of 24px from BS — released over the confirm row, which stays untouched', async () => {
    renderKeyboard();
    tap(key('esc'));
    const bs = key('bs');
    fireEvent.pointerDown(bs, { pointerId: 1, clientX: 25, clientY: 122 });
    // The key holds the capture, so the release is delivered to it even though
    // the finger is now above the keyboard, where `送信` is.
    fireEvent.pointerUp(bs, { pointerId: 1, clientX: 25, clientY: 122 - 60 });
    expect(chips()).toEqual(['ESC', 'DEL']);
    expect(calls).toHaveLength(0);
  });

  it('stages nothing when released outside the key, or on pointercancel', () => {
    renderKeyboard();
    const esc = key('esc');
    fireEvent.pointerDown(esc, { pointerId: 1, ...INSIDE });
    fireEvent.pointerUp(esc, { pointerId: 1, ...OUTSIDE });
    fireEvent.pointerDown(esc, { pointerId: 1, ...INSIDE });
    fireEvent.pointerCancel(esc, { pointerId: 1 });
    expect(chips()).toEqual([]);
    expect(sendButton()).toHaveTextContent('送信 (0)');
  });

  it('recovers when the pressed key disappears mid-press (the release lands elsewhere)', () => {
    renderKeyboard();
    openChars();
    fireEvent.pointerDown(charKey('a'), { pointerId: 7, ...INSIDE });
    // Another finger folds the panel: the pressed key is gone, and its release
    // arrives on whatever was under the finger.
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
    fireEvent.pointerUp(document.body, { pointerId: 7, ...INSIDE });
    expect(chips()).toEqual([]);
    // Not stuck on the orphaned gesture: the next tap is taken.
    tap(key('esc'));
    expect(chips()).toEqual(['ESC']);
  });

  it('ignores a secondary mouse button', () => {
    renderKeyboard();
    fireEvent.pointerDown(key('esc'), { pointerId: 1, button: 2, ...INSIDE });
    fireEvent.pointerUp(key('esc'), { pointerId: 1, button: 2, ...INSIDE });
    expect(chips()).toEqual([]);
  });

  it('activates a key reached by keyboard / assistive technology (a click with no pointer)', () => {
    renderKeyboard();
    fireEvent.click(key('enter')); // detail 0
    expect(chips()).toEqual(['ENTER']);
  });
});

describe('[#2799 §5] character keys', () => {
  it('draws the two pages, and each key stages its one character as text', async () => {
    renderKeyboard();
    openChars();
    typeText('q-/?');
    tap(screen.getByTestId('direct-key-page'));
    expect(screen.getByTestId('direct-input-char-panel')).toHaveAttribute('data-page', 'symbol');
    typeText('1"\\ ');
    expect(chips()).toEqual(['q-/?1"\\␣']);

    fireEvent.click(sendButton());
    expect(calls[0].body.events).toEqual([{ type: 'text', text: 'q-/?1"\\ ' }]);
    await act(async () => calls[0].settle());
  });
});

describe('[#2799 §6] staging and sending', () => {
  it('counts events: `yes` is N=1, three ↓ are N=3 drawn as ↓×3', () => {
    renderKeyboard();
    openChars();
    typeText('yes');
    expect(sendButton()).toHaveTextContent('送信 (1)');
    tap(key('down'));
    tap(key('down'));
    tap(key('down'));
    expect(sendButton()).toHaveTextContent('送信 (4)');
    expect(chips()).toEqual(['yes', '↓×3']);
    expect(screen.getByTestId('direct-input-count')).toHaveTextContent('送る予定 4 件');
  });

  it('取消 takes back the last event (one character of text), × clears everything', () => {
    renderKeyboard();
    openChars();
    tap(key('down'));
    tap(key('down'));
    tap(key('down'));
    fireEvent.click(screen.getByTestId('direct-input-undo'));
    expect(chips()).toEqual(['↓×2']);
    typeText('yes');
    fireEvent.click(screen.getByTestId('direct-input-undo'));
    expect(chips()).toEqual(['↓×2', 'ye']);
    fireEvent.click(screen.getByTestId('direct-input-clear'));
    expect(chips()).toEqual([]);
    expect(sendButton()).toHaveTextContent('送信 (0)');
  });

  it('does not let 送信 fire with nothing staged, and never adds Enter', async () => {
    renderKeyboard();
    expect(isDisabled(sendButton())).toBe(true);
    fireEvent.click(sendButton());
    expect(calls).toHaveLength(0);

    openChars();
    typeText('y');
    fireEvent.click(sendButton());
    expect(calls[0].body.events).toEqual([{ type: 'text', text: 'y' }]);
    await act(async () => calls[0].settle());
  });

  it('empties the list after a successful send', async () => {
    renderKeyboard();
    tap(key('esc'));
    fireEvent.click(sendButton());
    await act(async () => calls[0].settle());
    expect(chips()).toEqual([]);
    expect(sendButton()).toHaveTextContent('送信 (0)');
  });

  it('while sending: every key is unavailable, taps stage nothing, 送信 is off, the row is busy', async () => {
    renderKeyboard();
    openChars();
    tap(key('esc'));
    fireEvent.click(sendButton());
    expect(calls).toHaveLength(1);

    const row = screen.getByTestId('direct-input-confirm-row');
    expect(row).toHaveAttribute('aria-busy', 'true');
    expect(isDisabled(key('down'))).toBe(true);
    expect(isDisabled(charKey('a'))).toBe(true);
    expect(isDisabled(key('ctrl'))).toBe(true);
    expect(isDisabled(sendButton())).toBe(true);
    expect(isDisabled(screen.getByTestId('direct-input-undo'))).toBe(true);

    tap(key('down'));
    typeText('a');
    fireEvent.click(key('enter'));
    fireEvent.click(sendButton());
    fireEvent.click(screen.getByTestId('direct-input-undo'));
    expect(chips()).toEqual(['ESC']);
    expect(calls).toHaveLength(1);

    await act(async () => calls[0].settle());
    expect(row).not.toHaveAttribute('aria-busy');
    expect(chips()).toEqual([]);
  });

  it('after a failure: keeps the list, says it may have half-arrived, and holds 送信 until OK', async () => {
    renderKeyboard();
    tap(key('down'));
    tap(key('enter'));
    fireEvent.click(sendButton());
    await act(async () => calls[0].settle(false));

    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent('途中まで届いている場合があります');
    expect(chips()).toEqual(['↓', 'ENTER']);
    expect(isDisabled(sendButton())).toBe(true);
    fireEvent.click(sendButton());
    expect(calls).toHaveLength(1); // no resend, manual or automatic

    fireEvent.click(screen.getByTestId('direct-input-failed-ok'));
    expect(screen.queryByTestId('direct-input-failed')).not.toBeInTheDocument();
    expect(isDisabled(sendButton())).toBe(false);
    fireEvent.click(sendButton());
    expect(calls).toHaveLength(2);
    await act(async () => calls[1].settle());
  });

  it('after a failure: editing the list (取消 / × / a key) also re-enables 送信', async () => {
    renderKeyboard();
    for (const edit of ['undo', 'clear', 'key'] as const) {
      tap(key('down'));
      tap(key('down'));
      fireEvent.click(sendButton());
      await act(async () => calls[calls.length - 1].settle(false));
      expect(isDisabled(sendButton())).toBe(true);
      if (edit === 'undo') fireEvent.click(screen.getByTestId('direct-input-undo'));
      if (edit === 'clear') fireEvent.click(screen.getByTestId('direct-input-clear'));
      if (edit === 'key') tap(key('up'));
      expect(screen.queryByTestId('direct-input-failed')).not.toBeInTheDocument();
      fireEvent.click(screen.getByTestId('direct-input-clear'));
    }
  });

  it(`stops at ${MAX_DIRECT_INPUT_EVENTS}: keys go unavailable and a status line says why`, () => {
    renderKeyboard();
    openChars();
    for (let i = 0; i < MAX_DIRECT_INPUT_EVENTS + 3; i++) tap(key('down'));
    expect(sendButton()).toHaveTextContent(`送信 (${MAX_DIRECT_INPUT_EVENTS})`);
    expect(screen.getByRole('status')).toHaveTextContent('32 件までです。送信するか取り消してください');
    expect(isDisabled(key('down'))).toBe(true);
    expect(isDisabled(key('esc'))).toBe(true);
    expect(isDisabled(charKey('a'))).toBe(true);
    typeText('a');
    expect(sendButton()).toHaveTextContent(`送信 (${MAX_DIRECT_INPUT_EVENTS})`);
    // …and one 取消 frees a slot.
    fireEvent.click(screen.getByTestId('direct-input-undo'));
    expect(isDisabled(key('down'))).toBe(false);
    expect(screen.queryByTestId('direct-input-full')).not.toBeInTheDocument();
  });

  it('stops a held key\'s repeat at the cap', () => {
    vi.useFakeTimers();
    renderKeyboard();
    const down = key('down');
    fireEvent.pointerDown(down, { pointerId: 1, ...INSIDE });
    act(() => {
      vi.advanceTimersByTime(DIRECT_INPUT_LONG_PRESS_MS + DIRECT_INPUT_REPEAT_INTERVAL_MS * 100);
    });
    expect(sendButton()).toHaveTextContent(`送信 (${MAX_DIRECT_INPUT_EVENTS})`);
    fireEvent.pointerUp(down, { pointerId: 1, ...INSIDE });
    // The release after a repeat adds nothing more.
    expect(sendButton()).toHaveTextContent(`送信 (${MAX_DIRECT_INPUT_EVENTS})`);
  });

  it('repeats a held arrow every 80ms after the long press, and stages nothing more on release', () => {
    vi.useFakeTimers();
    renderKeyboard();
    const up = key('up');
    fireEvent.pointerDown(up, { pointerId: 1, ...INSIDE });
    act(() => {
      vi.advanceTimersByTime(DIRECT_INPUT_LONG_PRESS_MS - 1);
    });
    expect(chips()).toEqual([]);
    act(() => {
      vi.advanceTimersByTime(1 + DIRECT_INPUT_REPEAT_INTERVAL_MS * 2);
    });
    fireEvent.pointerUp(up, { pointerId: 1, ...INSIDE });
    expect(chips()).toEqual(['↑×3']);
  });

  it('keeps the list in memory only — nothing is written to localStorage or sessionStorage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    renderKeyboard();
    openChars();
    typeText('secret');
    tap(key('enter'));
    fireEvent.click(sendButton());
    await act(async () => calls[0].settle());
    expect(setItem).not.toHaveBeenCalled();
  });

  it('closes from 閉じる', () => {
    const { props } = renderKeyboard();
    fireEvent.click(screen.getByTestId('direct-input-close'));
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });
});

describe('[#2799 §4] modifiers', () => {
  it('CTRL then a stages C-a, and the one-shot is spent', () => {
    renderKeyboard();
    tap(key('ctrl'));
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'true');
    // Arming CTRL opens the letters.
    expect(screen.getByTestId('direct-input-char-panel')).toHaveAttribute('data-page', 'alpha');
    tap(charKey('a'));
    expect(chips()).toEqual(['^A']);
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'false');
    tap(charKey('a'));
    expect(chips()).toEqual(['^A', 'a']);
  });

  it('under CTRL only a–z can be pressed; the rest refuse the tap AND keep CTRL armed', () => {
    renderKeyboard();
    tap(key('ctrl'));
    for (const id of ['esc', 'enter', 'bs', 'tab', 'up', 'down', 'pgdn']) {
      expect(isDisabled(key(id)), id).toBe(true);
    }
    expect(isDisabled(charKey('-'))).toBe(true);
    expect(isDisabled(charKey(' '))).toBe(true);
    expect(isDisabled(charKey('z'))).toBe(false);

    tap(key('enter'));
    fireEvent.click(key('tab'));
    tap(charKey('-'));
    expect(chips()).toEqual([]);
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'true');
    tap(charKey('c'));
    expect(chips()).toEqual(['^C']);
  });

  it('SHIFT: letters stage upper case, TAB stages BTab, everything else is unavailable', () => {
    renderKeyboard();
    tap(key('shift'));
    expect(charKey('q')).toHaveTextContent('Q');
    expect(isDisabled(key('esc'))).toBe(true);
    expect(isDisabled(charKey('/'))).toBe(true);
    tap(charKey('q'));
    expect(chips()).toEqual(['Q']);
    expect(charKey('q')).toHaveTextContent('q'); // spent → lower case again
    tap(key('shift'));
    tap(key('tab'));
    expect(chips()).toEqual(['Q', '⇧TAB']);
  });

  it('a second tap on the same modifier releases it; the other one switches', () => {
    renderKeyboard();
    tap(key('ctrl'));
    tap(key('ctrl'));
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'false');
    tap(key('ctrl'));
    tap(key('shift'));
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'false');
    expect(key('shift')).toHaveAttribute('aria-pressed', 'true');
  });

  it('a long press locks; the lock survives staged keys and a tap releases it', () => {
    vi.useFakeTimers();
    renderKeyboard();
    const ctrl = key('ctrl');
    fireEvent.pointerDown(ctrl, { pointerId: 1, ...INSIDE });
    act(() => {
      vi.advanceTimersByTime(DIRECT_INPUT_LONG_PRESS_MS);
    });
    fireEvent.pointerUp(ctrl, { pointerId: 1, ...INSIDE });
    expect(ctrl).toHaveAttribute('data-modifier-state', 'locked');
    expect(ctrl).toHaveAttribute('aria-pressed', 'true');

    tap(charKey('a'));
    tap(charKey('b'));
    expect(chips()).toEqual(['^A', '^B']);
    expect(ctrl).toHaveAttribute('data-modifier-state', 'locked');

    tap(ctrl);
    expect(ctrl).toHaveAttribute('data-modifier-state', 'off');
  });

  it('取消 / 送信 / × / ABC are list operations and do not spend the modifier', async () => {
    renderKeyboard();
    tap(key('down'));
    tap(key('down'));
    tap(key('ctrl'));
    fireEvent.click(screen.getByTestId('direct-input-undo'));
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
    fireEvent.click(screen.getByTestId('direct-input-toggle-chars'));
    fireEvent.click(sendButton());
    await act(async () => calls[0].settle());
    tap(key('down')); // unavailable under CTRL — refused, CTRL kept
    fireEvent.click(screen.getByTestId('direct-input-clear'));
    expect(key('ctrl')).toHaveAttribute('aria-pressed', 'true');
  });

  it('switches a symbols page to letters when a modifier is armed, and locks the page key', () => {
    renderKeyboard();
    openChars();
    tap(screen.getByTestId('direct-key-page'));
    expect(screen.getByTestId('direct-input-char-panel')).toHaveAttribute('data-page', 'symbol');
    tap(key('shift'));
    expect(screen.getByTestId('direct-input-char-panel')).toHaveAttribute('data-page', 'alpha');
    const page = screen.getByTestId('direct-key-page');
    expect(isDisabled(page)).toBe(true);
    tap(page);
    expect(screen.getByTestId('direct-input-char-panel')).toHaveAttribute('data-page', 'alpha');
  });

  it('opens a folded character panel when a modifier is armed', () => {
    renderKeyboard();
    expect(screen.queryByTestId('direct-input-char-panel')).not.toBeInTheDocument();
    tap(key('ctrl'));
    expect(screen.getByTestId('direct-input-char-panel')).toBeInTheDocument();
  });
});

describe('[#2799 §7] press feedback', () => {
  it('holds the press colour and the enlarged bubble until the finger lifts', () => {
    vi.useFakeTimers();
    renderKeyboard();
    openChars();
    const a = charKey('a');
    fireEvent.pointerDown(a, { pointerId: 1, ...INSIDE });
    // Far past #2176's 150ms flash: still pressed.
    act(() => {
      vi.advanceTimersByTime(1000);
    });
    expect(within(a).getByTestId('direct-key-bubble')).toHaveTextContent('a');
    fireEvent.pointerUp(a, { pointerId: 1, ...INSIDE });
    expect(within(a).queryByTestId('direct-key-bubble')).not.toBeInTheDocument();
  });
});
