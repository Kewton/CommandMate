/**
 * The phone keyboard's staging rules (Issue #2799 §4 / §6 / §7).
 *
 * Pure functions, so every key × modifier combination is enumerated rather
 * than sampled, and every list operation is checked against the one invariant
 * the route imposes: each element passes `isDirectInputEvent` and there are at
 * most `MAX_DIRECT_INPUT_EVENTS` of them.
 */

import { describe, it, expect } from 'vitest';
import {
  isStagedFull,
  lockModifier,
  modifierAfterStage,
  resolveKeyPress,
  resolveRelease,
  stageEvent,
  tapModifier,
  toStagedChips,
  undoLastStaged,
  type KeyPress,
  type ModifierState,
} from '@/lib/direct-input-staging';
import { CHAR_PAGES, SPECIAL_KEY_ROWS } from '@/config/mobile-keyboard-layout';
import {
  DIRECT_INPUT_NAMED_KEY_VALUES,
  MAX_DIRECT_INPUT_EVENTS,
  MAX_DIRECT_INPUT_TEXT_LENGTH,
  isDirectInputEvent,
  type DirectInputEvent,
} from '@/types/direct-input';

const CTRL: ModifierState = { modifier: 'ctrl', locked: false };
const CTRL_LOCKED: ModifierState = { modifier: 'ctrl', locked: true };
const SHIFT: ModifierState = { modifier: 'shift', locked: false };
const SHIFT_LOCKED: ModifierState = { modifier: 'shift', locked: true };

const NAMED_PRESSES: KeyPress[] = DIRECT_INPUT_NAMED_KEY_VALUES.map((key) => ({ type: 'named', key }));
const CHAR_PRESSES: KeyPress[] = Object.values(CHAR_PAGES)
  .flatMap((page) => page.flat())
  .flatMap((def) => (def.kind === 'char' ? [{ type: 'char', char: def.char } as const] : []));
const LETTERS = 'abcdefghijklmnopqrstuvwxyz'.split('');

function expectValid(list: readonly DirectInputEvent[]): void {
  expect(list.length).toBeLessThanOrEqual(MAX_DIRECT_INPUT_EVENTS);
  for (const event of list) expect(isDirectInputEvent(event)).toBe(true);
}

function text(t: string): DirectInputEvent {
  return { type: 'text', text: t };
}

const DOWN: DirectInputEvent = { type: 'key', key: 'Down' };

describe('[#2799 §4] what a press stages under each modifier', () => {
  it('with no modifier: the named key, or the character as text', () => {
    for (const press of NAMED_PRESSES) {
      expect(resolveKeyPress(press, null)).toEqual({ type: 'key', key: (press as { key: string }).key });
    }
    for (const press of CHAR_PRESSES) {
      expect(resolveKeyPress(press, null)).toEqual({ type: 'text', text: (press as { char: string }).char });
    }
  });

  for (const state of [CTRL, CTRL_LOCKED]) {
    it(`CTRL (${state?.locked ? 'locked' : 'one-shot'}): a–z become C-a … C-z, and nothing else stages`, () => {
      for (const letter of LETTERS) {
        expect(resolveKeyPress({ type: 'char', char: letter }, state)).toEqual({ type: 'key', key: `C-${letter}` });
      }
      for (const press of CHAR_PRESSES) {
        if (press.type === 'char' && LETTERS.includes(press.char)) continue;
        expect(resolveKeyPress(press, state), JSON.stringify(press)).toBeNull();
      }
      // Every named key — TAB and ENTER included — is off under CTRL.
      for (const press of NAMED_PRESSES) expect(resolveKeyPress(press, state)).toBeNull();
    });
  }

  for (const state of [SHIFT, SHIFT_LOCKED]) {
    it(`SHIFT (${state?.locked ? 'locked' : 'one-shot'}): letters upper-case, TAB becomes BTab, nothing else stages`, () => {
      for (const letter of LETTERS) {
        expect(resolveKeyPress({ type: 'char', char: letter }, state)).toEqual(text(letter.toUpperCase()));
      }
      expect(resolveKeyPress({ type: 'named', key: 'Tab' }, state)).toEqual({ type: 'key', key: 'BTab' });
      for (const press of NAMED_PRESSES) {
        if (press.type === 'named' && press.key === 'Tab') continue;
        expect(resolveKeyPress(press, state)).toBeNull();
      }
      for (const press of CHAR_PRESSES) {
        if (press.type === 'char' && LETTERS.includes(press.char)) continue;
        expect(resolveKeyPress(press, state), JSON.stringify(press)).toBeNull();
      }
    });
  }

  it('CTRL then a stages C-a (the acceptance criterion)', () => {
    expect(resolveKeyPress({ type: 'char', char: 'a' }, tapModifier(null, 'ctrl'))).toEqual({ type: 'key', key: 'C-a' });
  });

  it('every special key tap resolves to a valid event or to null — never to anything else', () => {
    for (const state of [null, CTRL, SHIFT]) {
      for (const def of SPECIAL_KEY_ROWS.flat()) {
        if (def.kind !== 'named') continue;
        const event = resolveKeyPress({ type: 'named', key: def.key }, state);
        if (event !== null) expect(isDirectInputEvent(event)).toBe(true);
      }
    }
  });
});

describe('[#2799 §4] modifier transitions', () => {
  it('a tap arms a one-shot; tapping it again releases it', () => {
    const armed = tapModifier(null, 'ctrl');
    expect(armed).toEqual({ modifier: 'ctrl', locked: false });
    expect(tapModifier(armed, 'ctrl')).toBeNull();
  });

  it('a long press locks; a tap on the locked key releases it', () => {
    const locked = lockModifier('shift');
    expect(locked).toEqual({ modifier: 'shift', locked: true });
    expect(tapModifier(locked, 'shift')).toBeNull();
  });

  it('never has CTRL and SHIFT on together', () => {
    expect(tapModifier(CTRL, 'shift')).toEqual({ modifier: 'shift', locked: false });
    expect(tapModifier(SHIFT_LOCKED, 'ctrl')).toEqual({ modifier: 'ctrl', locked: false });
    expect(lockModifier('ctrl')).toEqual({ modifier: 'ctrl', locked: true });
  });

  it('a one-shot is spent by a staged key, a lock is not', () => {
    expect(modifierAfterStage(CTRL)).toBeNull();
    expect(modifierAfterStage(SHIFT)).toBeNull();
    expect(modifierAfterStage(CTRL_LOCKED)).toBe(CTRL_LOCKED);
    expect(modifierAfterStage(SHIFT_LOCKED)).toBe(SHIFT_LOCKED);
    expect(modifierAfterStage(null)).toBeNull();
  });
});

describe('[#2799 §6] staging', () => {
  it('merges consecutive characters into ONE text event — `yes` is N=1', () => {
    let list: DirectInputEvent[] = [];
    for (const char of 'yes') list = stageEvent(list, text(char))!;
    expect(list).toEqual([text('yes')]);
    expect(list).toHaveLength(1);
  });

  it('never merges keys — three ↓ are three events', () => {
    let list: DirectInputEvent[] = [];
    for (let i = 0; i < 3; i++) list = stageEvent(list, DOWN)!;
    expect(list).toEqual([DOWN, DOWN, DOWN]);
  });

  it('starts a new text event after a key, and keeps the order', () => {
    let list: DirectInputEvent[] = [];
    list = stageEvent(list, text('a'))!;
    list = stageEvent(list, { type: 'key', key: 'Enter' })!;
    list = stageEvent(list, text('b'))!;
    list = stageEvent(list, text('c'))!;
    expect(list).toEqual([text('a'), { type: 'key', key: 'Enter' }, text('bc')]);
  });

  it(`splits text at MAX_DIRECT_INPUT_TEXT_LENGTH (${MAX_DIRECT_INPUT_TEXT_LENGTH}) so the list stays valid`, () => {
    const long = 'x'.repeat(MAX_DIRECT_INPUT_TEXT_LENGTH);
    const list = stageEvent([text(long)], text('y'))!;
    expect(list).toEqual([text(long), text('y')]);
    expectValid(list);
  });

  it(`refuses the ${MAX_DIRECT_INPUT_EVENTS + 1}th event, and reports full at ${MAX_DIRECT_INPUT_EVENTS}`, () => {
    let list: DirectInputEvent[] = [];
    for (let i = 0; i < MAX_DIRECT_INPUT_EVENTS; i++) {
      expect(isStagedFull(list)).toBe(false);
      list = stageEvent(list, DOWN)!;
    }
    expect(list).toHaveLength(MAX_DIRECT_INPUT_EVENTS);
    expect(isStagedFull(list)).toBe(true);
    expect(stageEvent(list, DOWN)).toBeNull();
    // Full means full: not even a character that could have merged.
    expect(stageEvent([...list.slice(0, -1), text('a')], text('b'))).toBeNull();
    expectValid(list);
  });

  it('keeps every intermediate list valid under a long random sequence', () => {
    let list: DirectInputEvent[] = [];
    const pool: DirectInputEvent[] = [text('a'), text(' '), DOWN, { type: 'key', key: 'C-a' }, text('Z')];
    let seed = 7;
    for (let i = 0; i < 200; i++) {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      const next = seed % 7 === 0 ? undoLastStaged(list) : stageEvent(list, pool[seed % pool.length]);
      if (next !== null) list = next;
      expectValid(list);
    }
  });
});

describe('[#2799 §6] undo and chips', () => {
  it('取消 takes back the last event: ↓×3 becomes ↓×2', () => {
    expect(undoLastStaged([DOWN, DOWN, DOWN])).toEqual([DOWN, DOWN]);
    expect(toStagedChips([DOWN, DOWN])).toEqual([{ label: '↓', count: 2, event: DOWN }]);
  });

  it('取消 on merged text removes one character, and the event with its last one', () => {
    expect(undoLastStaged([text('yes')])).toEqual([text('ye')]);
    expect(undoLastStaged([DOWN, text('y')])).toEqual([DOWN]);
  });

  it('取消 on an empty list is an empty list', () => {
    expect(undoLastStaged([])).toEqual([]);
  });

  it('draws consecutive identical keys as one chip with a count, and leaves N alone', () => {
    const list: DirectInputEvent[] = [DOWN, DOWN, DOWN, { type: 'key', key: 'Enter' }, text('yes'), DOWN];
    expect(toStagedChips(list).map(({ label, count }) => [label, count])).toEqual([
      ['↓', 3],
      ['ENTER', 1],
      ['yes', 1],
      ['↓', 1],
    ]);
    expect(list).toHaveLength(6);
  });

  it('labels control keys in caret notation', () => {
    expect(toStagedChips([{ type: 'key', key: 'C-a' }])[0].label).toBe('^A');
    expect(toStagedChips([{ type: 'key', key: 'BTab' }])[0].label).toBe('⇧TAB');
  });
});

describe('[#2799 §7] resolving a release', () => {
  const rect = { left: 100, top: 200, right: 150, bottom: 244 };
  const start = { x: 125, y: 240 };

  it('is a tap when released inside the key it started on', () => {
    expect(resolveRelease(start, { x: 140, y: 230 }, rect, false)).toBe('tap');
    expect(resolveRelease(start, { x: 140, y: 230 }, rect, true)).toBe('tap');
  });

  it('is nothing when released outside the key', () => {
    expect(resolveRelease(start, { x: 170, y: 240 }, rect, false)).toBe('none');
    expect(resolveRelease(start, { x: 125, y: 260 }, rect, false)).toBe('none');
  });

  it('is the swipe action after 24px of upward travel on a key that has one', () => {
    expect(resolveRelease(start, { x: 125, y: 240 - 24 }, rect, true)).toBe('swipe');
    expect(resolveRelease(start, { x: 125, y: 240 - 23 }, rect, true)).toBe('tap');
    // Released far above — over the confirm row — is still the swipe.
    expect(resolveRelease(start, { x: 125, y: 120 }, rect, true)).toBe('swipe');
  });

  it('never swipes a key without a swipe action', () => {
    expect(resolveRelease(start, { x: 125, y: 120 }, rect, false)).toBe('none');
  });
});
