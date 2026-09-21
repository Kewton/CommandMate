/**
 * The phone's direct-input keyboard, as data (Issue #2799).
 *
 * This file IS the layout Issue #2799 specifies — the two special-key rows
 * (§3) and the two character pages (§5) — so a reviewer can hold the Issue's
 * tables next to the arrays below and compare them cell by cell. Rendering
 * lives in `MobileDirectInputKeyboard`; what a key stages under a modifier
 * lives in `src/lib/direct-input-staging.ts`. Nothing here touches the DOM.
 *
 * ## Why Termux's arrangement
 *
 * The special rows keep eleven of Termux's default Extra Keys
 * (`TermuxPropertyConstants.DEFAULT_IVALUE_EXTRA_KEYS`) in the cells Termux
 * puts them in, and replace three:
 *
 *  - `/` and `-` are characters, so they moved to the character page and their
 *    cells hold ENTER and BS (BS swipes up to DEL, the way Termux's `-` swipes
 *    up to `|`);
 *  - `ALT` is not in the direct-input vocabulary (`src/types/direct-input.ts`),
 *    so its cell holds SHIFT, which is the only way to reach `BTab`.
 *
 * With CTRL applied to the letters, the two rows reach all 40 values of
 * `DIRECT_INPUT_KEY_VALUES`; with SHIFT applied to the letters, the two pages
 * reach all 95 printable ASCII characters. `tests/unit/config/
 * mobile-keyboard-layout-2799.test.ts` enumerates both.
 */

import type { DirectInputKey } from '@/types/direct-input';

// ============================================================================
// Timing and gesture constants (§4, §7)
// ============================================================================

/**
 * How long a finger has to stay on CTRL / SHIFT to lock it, and on a repeating
 * key before it starts to repeat. Issue #2799 asks for 400–500ms; Termux uses
 * Android's `ViewConfiguration.getLongPressTimeout()` (400ms by default).
 */
export const DIRECT_INPUT_LONG_PRESS_MS = 450;

/**
 * Interval between repeats while a repeating key is held — Termux's
 * `DEFAULT_LONG_PRESS_REPEAT_DELAY`. At 80ms the 32-event cap is reached in
 * about 2.6 seconds, and the repeat stops there; that is the API's per-request
 * limit, not a defect. May be tuned after the device UAT.
 */
export const DIRECT_INPUT_REPEAT_INTERVAL_MS = 80;

/** Upward travel (px) from `pointerdown` that turns a release into the key's swipe-up action. */
export const DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX = 24;

// ============================================================================
// Special keys (§3)
// ============================================================================

/** A special key that stages a vocabulary key. */
export interface NamedKeyDef {
  readonly kind: 'named';
  /** Stable id: test ids (`direct-key-<id>`) and the `directInputKeyboard.keys.<id>` label. */
  readonly id: string;
  /** What the key face shows. */
  readonly label: string;
  /** What a tap stages. */
  readonly key: DirectInputKey;
  /** What an upward swipe stages instead (BS → DEL only). */
  readonly swipeUp?: { readonly key: DirectInputKey; readonly label: string };
  /** Held down, the key repeats (Termux's `PRIMARY_REPETITIVE_KEYS`). */
  readonly repeats: boolean;
}

/** CTRL / SHIFT. They stage nothing themselves; they change what the next key stages. */
export interface ModifierKeyDef {
  readonly kind: 'modifier';
  readonly id: DirectInputModifier;
  readonly label: string;
}

export type DirectInputModifier = 'ctrl' | 'shift';

export type SpecialKeyDef = NamedKeyDef | ModifierKeyDef;

function named(
  id: string,
  label: string,
  key: DirectInputKey,
  repeats: boolean,
  swipeUp?: NamedKeyDef['swipeUp'],
): NamedKeyDef {
  return swipeUp ? { kind: 'named', id, label, key, repeats, swipeUp } : { kind: 'named', id, label, key, repeats };
}

/**
 * Issue #2799 §3, row for row:
 *
 * | ESC | ENTER | BS (↑ DEL) | HOME | ↑ | END   | PGUP |
 * | TAB | CTRL  | SHIFT      | ←    | ↓ | →     | PGDN |
 */
export const SPECIAL_KEY_ROWS: readonly (readonly SpecialKeyDef[])[] = [
  [
    named('esc', 'ESC', 'Escape', false),
    named('enter', 'ENTER', 'Enter', false),
    named('bs', 'BS', 'BSpace', true, { key: 'DC', label: 'DEL' }),
    named('home', 'HOME', 'Home', false),
    named('up', '↑', 'Up', true),
    named('end', 'END', 'End', false),
    named('pgup', 'PGUP', 'PageUp', true),
  ],
  [
    named('tab', 'TAB', 'Tab', false),
    { kind: 'modifier', id: 'ctrl', label: 'CTRL' },
    { kind: 'modifier', id: 'shift', label: 'SHIFT' },
    named('left', '←', 'Left', true),
    named('down', '↓', 'Down', true),
    named('right', '→', 'Right', true),
    named('pgdn', 'PGDN', 'PageDown', true),
  ],
];

/** Columns in each special row. At 360px each key is ~51px wide — #1127's 44px holds. */
export const SPECIAL_KEY_COLUMNS = 7;

// ============================================================================
// Character pages (§5)
// ============================================================================

export type CharPageId = 'alpha' | 'symbol';

/** A key that stages its one character as `{ type: 'text' }`. */
export interface CharKeyDef {
  readonly kind: 'char';
  readonly char: string;
  /** Width in columns of the 10-column grid (the space bar is 4). */
  readonly span: number;
}

/** The bottom-left key that flips between the two pages, like an OS keyboard's `123` / `ABC`. */
export interface PageKeyDef {
  readonly kind: 'page';
  readonly target: CharPageId;
  readonly label: string;
  readonly span: number;
}

export type CharPanelKeyDef = CharKeyDef | PageKeyDef;

/** Columns of the character grid. At 360px a key is ~36px wide — the one #1127 exception. */
export const CHAR_PANEL_COLUMNS = 10;

function chars(row: string): CharKeyDef[] {
  return [...row].map((char) => ({ kind: 'char', char, span: 1 }));
}

/**
 * The bottom row: page key 2 / char 1 / char 1 / space 4 / char 1 / char 1
 * — Issue #2799 §5's division of the ten columns.
 */
function bottomRow(page: PageKeyDef, left: string, right: string): CharPanelKeyDef[] {
  return [
    page,
    ...chars(left),
    { kind: 'char', char: ' ', span: 4 },
    ...chars(right),
  ];
}

/**
 * ```
 * q w e r t y u i o p
 * a s d f g h j k l -
 * z x c v b n m , . /
 * [123] _ : [  space  ] ' ?
 * ```
 */
const ALPHA_PAGE: readonly (readonly CharPanelKeyDef[])[] = [
  chars('qwertyuiop'),
  chars('asdfghjkl-'),
  chars('zxcvbnm,./'),
  bottomRow({ kind: 'page', target: 'symbol', label: '123', span: 2 }, '_:', "'?"),
];

/**
 * ```
 * 1 2 3 4 5 6 7 8 9 0
 * ! @ # $ % ^ & * ( )
 * ~ ` | \ [ ] { } < >
 * [ABC] + = [  space  ] ; "
 * ```
 */
const SYMBOL_PAGE: readonly (readonly CharPanelKeyDef[])[] = [
  chars('1234567890'),
  chars('!@#$%^&*()'),
  chars('~`|\\[]{}<>'),
  bottomRow({ kind: 'page', target: 'alpha', label: 'ABC', span: 2 }, '+=', ';"'),
];

export const CHAR_PAGES: Readonly<Record<CharPageId, readonly (readonly CharPanelKeyDef[])[]>> = {
  alpha: ALPHA_PAGE,
  symbol: SYMBOL_PAGE,
};

// ============================================================================
// Labels
// ============================================================================

/**
 * Test id of a character key. By code point rather than by the character, so
 * `"`, `\` and space need no escaping in a selector.
 */
export function charKeyTestId(char: string): string {
  return `direct-key-char-${char.codePointAt(0)}`;
}

const NAMED_KEY_CHIP_LABELS: Readonly<Partial<Record<DirectInputKey, string>>> = {
  Escape: 'ESC',
  Enter: 'ENTER',
  BSpace: 'BS',
  DC: 'DEL',
  Home: 'HOME',
  End: 'END',
  PageUp: 'PGUP',
  PageDown: 'PGDN',
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Tab: 'TAB',
  BTab: '⇧TAB',
};

/** The staged-row chip text for a key event: the key face, `⇧TAB`, or `^A` for `C-a`. */
export function keyChipLabel(key: DirectInputKey): string {
  const labelled = NAMED_KEY_CHIP_LABELS[key];
  if (labelled !== undefined) return labelled;
  // `C-a` … `C-z`: the caret notation terminals print for control characters.
  return `^${key.slice(2).toUpperCase()}`;
}
