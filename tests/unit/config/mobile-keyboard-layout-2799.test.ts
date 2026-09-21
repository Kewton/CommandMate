/**
 * The phone's direct-input keyboard layout (Issue #2799 §3 / §5).
 *
 * The Issue fixes the layout cell by cell — Termux's Extra Keys with three
 * cells replaced, and two ten-column character pages — and says
 * `src/config/mobile-keyboard-layout.ts` IS that layout. This file pins the
 * arrays to the Issue's tables, and then pins the two properties the layout
 * exists to have, by enumerating every key under every modifier state through
 * the same `resolveKeyPress` the keyboard uses:
 *
 *  - all 40 values of `DIRECT_INPUT_KEY_VALUES` are reachable (`BTab` only
 *    through SHIFT → TAB, `DC` only through the BS swipe);
 *  - all 95 printable ASCII characters are reachable (upper case only through
 *    SHIFT).
 */

import { describe, it, expect } from 'vitest';
import {
  CHAR_PAGES,
  CHAR_PANEL_COLUMNS,
  SPECIAL_KEY_COLUMNS,
  SPECIAL_KEY_ROWS,
  DIRECT_INPUT_LONG_PRESS_MS,
  DIRECT_INPUT_REPEAT_INTERVAL_MS,
  DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX,
  charKeyTestId,
  keyChipLabel,
  type CharPanelKeyDef,
  type SpecialKeyDef,
} from '@/config/mobile-keyboard-layout';
import { resolveKeyPress, type KeyPress, type ModifierState } from '@/lib/direct-input-staging';
import {
  DIRECT_INPUT_KEY_VALUES,
  isDirectInputEvent,
  type DirectInputEvent,
} from '@/types/direct-input';

/** Every modifier state the keyboard can be in. */
const MODIFIER_STATES: readonly ModifierState[] = [
  null,
  { modifier: 'ctrl', locked: false },
  { modifier: 'ctrl', locked: true },
  { modifier: 'shift', locked: false },
  { modifier: 'shift', locked: true },
];

function faceOf(def: SpecialKeyDef): string {
  return def.label;
}

function charFace(def: CharPanelKeyDef): string {
  if (def.kind === 'page') return `[${def.label}]`;
  return def.char === ' ' ? '[space]' : def.char;
}

/** Every press a finger can produce: taps on every key, plus the BS swipe. */
function allPresses(): KeyPress[] {
  const presses: KeyPress[] = [];
  for (const row of SPECIAL_KEY_ROWS) {
    for (const def of row) {
      if (def.kind !== 'named') continue;
      presses.push({ type: 'named', key: def.key });
      if (def.swipeUp) presses.push({ type: 'named', key: def.swipeUp.key });
    }
  }
  for (const page of Object.values(CHAR_PAGES)) {
    for (const row of page) {
      for (const def of row) {
        if (def.kind === 'char') presses.push({ type: 'char', char: def.char });
      }
    }
  }
  return presses;
}

function allReachableEvents(): DirectInputEvent[] {
  const events: DirectInputEvent[] = [];
  for (const state of MODIFIER_STATES) {
    for (const press of allPresses()) {
      const event = resolveKeyPress(press, state);
      if (event !== null) events.push(event);
    }
  }
  return events;
}

describe('[#2799 §3] the special-key rows', () => {
  it('are exactly the Issue table, cell for cell', () => {
    expect(SPECIAL_KEY_ROWS.map((row) => row.map(faceOf))).toEqual([
      ['ESC', 'ENTER', 'BS', 'HOME', '↑', 'END', 'PGUP'],
      ['TAB', 'CTRL', 'SHIFT', '←', '↓', '→', 'PGDN'],
    ]);
    for (const row of SPECIAL_KEY_ROWS) expect(row).toHaveLength(SPECIAL_KEY_COLUMNS);
  });

  it('keeps Termux\'s eleven keys in Termux\'s cells', () => {
    // DEFAULT_IVALUE_EXTRA_KEYS: [ESC / - HOME UP END PGUP] [TAB CTRL ALT LEFT DOWN RIGHT PGDN].
    // `/` → ENTER, `-` → BS, ALT → SHIFT are the Issue's three replacements.
    const termux = [
      ['ESC', null, null, 'HOME', '↑', 'END', 'PGUP'],
      ['TAB', 'CTRL', null, '←', '↓', '→', 'PGDN'],
    ];
    termux.forEach((row, r) =>
      row.forEach((face, c) => {
        if (face !== null) expect(faceOf(SPECIAL_KEY_ROWS[r][c])).toBe(face);
      }),
    );
  });

  it('stages the vocabulary key the Issue names for each face', () => {
    const staged = Object.fromEntries(
      SPECIAL_KEY_ROWS.flat()
        .filter((def) => def.kind === 'named')
        .map((def) => [def.label, def.key]),
    );
    expect(staged).toEqual({
      ESC: 'Escape',
      ENTER: 'Enter',
      BS: 'BSpace',
      HOME: 'Home',
      '↑': 'Up',
      END: 'End',
      PGUP: 'PageUp',
      TAB: 'Tab',
      '←': 'Left',
      '↓': 'Down',
      '→': 'Right',
      PGDN: 'PageDown',
    });
  });

  it('gives BS, and only BS, a swipe-up action: DEL', () => {
    const swipes = SPECIAL_KEY_ROWS.flat().filter((def) => def.kind === 'named' && def.swipeUp);
    expect(swipes).toHaveLength(1);
    expect(swipes[0]).toMatchObject({ id: 'bs', swipeUp: { key: 'DC', label: 'DEL' } });
  });

  it('repeats exactly Termux\'s PRIMARY_REPETITIVE_KEYS when held', () => {
    const repeating = SPECIAL_KEY_ROWS.flat()
      .filter((def) => def.kind === 'named' && def.repeats)
      .map((def) => def.label)
      .sort();
    expect(repeating).toEqual(['BS', 'PGDN', 'PGUP', '←', '↑', '→', '↓'].sort());
  });

  it('has CTRL and SHIFT as the only modifiers', () => {
    const modifiers = SPECIAL_KEY_ROWS.flat().filter((def) => def.kind === 'modifier');
    expect(modifiers.map((def) => def.id)).toEqual(['ctrl', 'shift']);
  });
});

describe('[#2799 §5] the character pages', () => {
  it('is the letters page of the Issue', () => {
    expect(CHAR_PAGES.alpha.map((row) => row.map(charFace).join(' '))).toEqual([
      'q w e r t y u i o p',
      'a s d f g h j k l -',
      'z x c v b n m , . /',
      "[123] _ : [space] ' ?",
    ]);
  });

  it('is the numbers-and-symbols page of the Issue', () => {
    expect(CHAR_PAGES.symbol.map((row) => row.map(charFace).join(' '))).toEqual([
      '1 2 3 4 5 6 7 8 9 0',
      '! @ # $ % ^ & * ( )',
      '~ ` | \\ [ ] { } < >',
      '[ABC] + = [space] ; "',
    ]);
  });

  it('fills every row to exactly ten columns, the bottom row as 2 / 1 / 1 / 4 / 1 / 1', () => {
    for (const page of Object.values(CHAR_PAGES)) {
      for (const row of page) {
        expect(row.reduce((sum, def) => sum + def.span, 0)).toBe(CHAR_PANEL_COLUMNS);
      }
      expect(page[3].map((def) => def.span)).toEqual([2, 1, 1, 4, 1, 1]);
    }
  });

  it('flips between the two pages from the bottom-left key', () => {
    expect(CHAR_PAGES.alpha[3][0]).toMatchObject({ kind: 'page', target: 'symbol', label: '123' });
    expect(CHAR_PAGES.symbol[3][0]).toMatchObject({ kind: 'page', target: 'alpha', label: 'ABC' });
  });

  it('puts neither SHIFT nor BS on a character page', () => {
    // They live in the special rows (§5), so the pages carry only characters.
    for (const page of Object.values(CHAR_PAGES)) {
      for (const def of page.flat()) {
        if (def.kind === 'char') expect([...def.char]).toHaveLength(1);
      }
    }
  });

  it('gives every character key on a page a unique, selector-safe test id', () => {
    // Per page: the space bar is on both, and only one page is ever mounted.
    for (const page of Object.values(CHAR_PAGES)) {
      const ids = page
        .flat()
        .filter((def) => def.kind === 'char')
        .map((def) => charKeyTestId(def.char));
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) expect(id).toMatch(/^direct-key-char-\d+$/);
    }
  });
});

describe('[#2799] reachability — the invariants the layout exists for', () => {
  const events = allReachableEvents();

  it('reaches all 40 DIRECT_INPUT_KEY_VALUES', () => {
    const keys = new Set(events.flatMap((event) => (event.type === 'key' ? [event.key] : [])));
    expect([...keys].sort()).toEqual([...DIRECT_INPUT_KEY_VALUES].sort());
    expect(keys.size).toBe(40);
  });

  it('reaches BTab only through SHIFT → TAB', () => {
    for (const state of MODIFIER_STATES) {
      for (const press of allPresses()) {
        const event = resolveKeyPress(press, state);
        if (event?.type === 'key' && event.key === 'BTab') {
          expect(state?.modifier).toBe('shift');
          expect(press).toEqual({ type: 'named', key: 'Tab' });
        }
      }
    }
  });

  it('reaches all 95 printable ASCII characters', () => {
    const printable = Array.from({ length: 0x7e - 0x20 + 1 }, (_, i) => String.fromCharCode(0x20 + i));
    const typed = new Set(events.flatMap((event) => (event.type === 'text' ? [event.text] : [])));
    expect(printable).toHaveLength(95);
    for (const char of printable) expect(typed, `missing ${JSON.stringify(char)}`).toContain(char);
    // …and nothing outside that range.
    for (const text of typed) expect(printable).toContain(text);
  });

  it('produces only events the route accepts', () => {
    for (const event of events) expect(isDirectInputEvent(event)).toBe(true);
  });
});

describe('[#2799] constants', () => {
  it('holds the long press inside the Issue\'s 400–500ms and the repeat at Termux\'s 80ms', () => {
    expect(DIRECT_INPUT_LONG_PRESS_MS).toBeGreaterThanOrEqual(400);
    expect(DIRECT_INPUT_LONG_PRESS_MS).toBeLessThanOrEqual(500);
    expect(DIRECT_INPUT_REPEAT_INTERVAL_MS).toBe(80);
    expect(DIRECT_INPUT_SWIPE_UP_THRESHOLD_PX).toBe(24);
  });

  it('labels staged keys the way the key faces read, with caret notation for Ctrl', () => {
    expect(keyChipLabel('Down')).toBe('↓');
    expect(keyChipLabel('BSpace')).toBe('BS');
    expect(keyChipLabel('DC')).toBe('DEL');
    expect(keyChipLabel('BTab')).toBe('⇧TAB');
    expect(keyChipLabel('C-a')).toBe('^A');
    expect(keyChipLabel('C-z')).toBe('^Z');
    for (const key of DIRECT_INPUT_KEY_VALUES) expect(keyChipLabel(key).length).toBeGreaterThan(0);
  });
});
