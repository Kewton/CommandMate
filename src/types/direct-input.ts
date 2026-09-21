/**
 * Direct terminal input vocabulary (Issue #2764).
 *
 * The "direct input" mode sends what the user types straight to an agent's tmux
 * pane, without asking the detection layer what is on screen. It exists for the
 * frames detection cannot read: an overlay that needs a key no button offers
 * (Command Code's plan review wants `ctrl+a`) used to leave the session with no
 * way forward from the browser.
 *
 * Values and pure functions only — no tmux, no DOM — so this module is safe to
 * import from the server, the CLI and the browser bundle alike, the same
 * property `terminal-keys.ts` keeps.
 */

/** tmux key names direct input may send. Each one was measured on tmux 3.5a. */
export const DIRECT_INPUT_NAMED_KEY_VALUES = [
  'Enter', 'Escape', 'Tab', 'BTab', 'BSpace', 'DC',
  'Up', 'Down', 'Left', 'Right',
  'Home', 'End', 'PageUp', 'PageDown',
] as const;

/** `C-a` … `C-z`. tmux 3.5a delivers these as 0x01 … 0x1a. */
export const DIRECT_INPUT_CTRL_KEY_VALUES = [
  'C-a', 'C-b', 'C-c', 'C-d', 'C-e', 'C-f', 'C-g', 'C-h', 'C-i', 'C-j', 'C-k', 'C-l', 'C-m',
  'C-n', 'C-o', 'C-p', 'C-q', 'C-r', 'C-s', 'C-t', 'C-u', 'C-v', 'C-w', 'C-x', 'C-y', 'C-z',
] as const;

export const DIRECT_INPUT_KEY_VALUES = [
  ...DIRECT_INPUT_NAMED_KEY_VALUES,
  ...DIRECT_INPUT_CTRL_KEY_VALUES,
] as const;

export type DirectInputKey = typeof DIRECT_INPUT_KEY_VALUES[number];

/** One thing the user did: pressed a named key, or produced text. */
export type DirectInputEvent =
  | { readonly type: 'key'; readonly key: DirectInputKey }
  | { readonly type: 'text'; readonly text: string };

/** Most events one request may carry. */
export const MAX_DIRECT_INPUT_EVENTS = 32;

/** Longest `text` one event may carry, in UTF-16 code units (a paste). */
export const MAX_DIRECT_INPUT_TEXT_LENGTH = 4096;

export function isDirectInputKey(value: unknown): value is DirectInputKey {
  return typeof value === 'string' && (DIRECT_INPUT_KEY_VALUES as readonly string[]).includes(value);
}

export function isDirectInputEvent(value: unknown): value is DirectInputEvent {
  if (typeof value !== 'object' || value === null) return false;
  const event = value as { type?: unknown; key?: unknown; text?: unknown };
  if (event.type === 'key') return isDirectInputKey(event.key);
  if (event.type === 'text') {
    return (
      typeof event.text === 'string' &&
      event.text.length > 0 &&
      event.text.length <= MAX_DIRECT_INPUT_TEXT_LENGTH
    );
  }
  return false;
}

/** The fields of a DOM `KeyboardEvent` the encoder reads. */
export interface KeyEventLike {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly altKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  /** Legacy, but the one IME signal older Safari still gets right (see below). */
  readonly keyCode?: number;
}

/**
 * The `keyCode` every browser gives a keydown the IME is handling. No physical
 * key maps to it, so treating it as "not ours" costs ordinary typing nothing.
 */
const IME_PROCESS_KEY_CODE = 229;

const NAMED_KEY_BY_DOM_KEY: Readonly<Record<string, DirectInputKey>> = {
  Enter: 'Enter',
  Escape: 'Escape',
  Backspace: 'BSpace',
  Delete: 'DC',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/**
 * Turn one keydown into the event to send, or `null` to leave it to the browser.
 *
 * `null` is an answer, not a failure: the caller must NOT `preventDefault()` on
 * it, so Cmd+C / Cmd+V / Cmd+R, IME composition and function keys keep working.
 *
 * IME is checked twice because `isComposing` alone misses the key that matters
 * most (Issue #2801). Safari before WebKit 310826@main fires the Enter that
 * commits a composition AFTER `compositionend`, with `isComposing: false` — so
 * the committed text would reach the pane followed by an Enter the user meant
 * for the IME, submitting the composer or confirming a dialog's highlighted
 * option. That keydown still carries `keyCode` 229, the same test
 * `MessageInput` uses.
 */
export function encodeKeyEvent(event: KeyEventLike): DirectInputEvent | null {
  if (event.isComposing === true || event.keyCode === IME_PROCESS_KEY_CODE) return null;
  if (event.metaKey || event.altKey) return null;

  if (event.key === 'Tab') {
    if (event.ctrlKey) return null;
    return { type: 'key', key: event.shiftKey ? 'BTab' : 'Tab' };
  }

  if (event.ctrlKey) {
    if (event.key.length !== 1) return null;
    const candidate = `C-${event.key.toLowerCase()}`;
    return isDirectInputKey(candidate) ? { type: 'key', key: candidate } : null;
  }

  const named = NAMED_KEY_BY_DOM_KEY[event.key];
  if (named !== undefined) return { type: 'key', key: named };

  // A printable key: `KeyboardEvent.key` is the character itself, which is one
  // code point (one or two UTF-16 units). `Dead`, `Shift`, `F5`, `Process`,
  // `Unidentified` … are all longer than one code point and fall through.
  if ([...event.key].length === 1) return { type: 'text', text: event.key };
  return null;
}
