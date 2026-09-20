/**
 * 直接入力の語彙と、keydown → 送信イベントの変換（Issue #2764）
 */
import { describe, it, expect } from 'vitest';
import {
  DIRECT_INPUT_CTRL_KEY_VALUES,
  DIRECT_INPUT_KEY_VALUES,
  DIRECT_INPUT_NAMED_KEY_VALUES,
  MAX_DIRECT_INPUT_TEXT_LENGTH,
  encodeKeyEvent,
  isDirectInputEvent,
  isDirectInputKey,
  type KeyEventLike,
} from '@/types/direct-input';

const press = (key: string, modifiers: Partial<KeyEventLike> = {}) =>
  encodeKeyEvent({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  });

describe('[#2764] 語彙', () => {
  it('名前付きキーは 14 個、Ctrl は a〜z の 26 個、合計 40 個で重複が無い', () => {
    expect(DIRECT_INPUT_NAMED_KEY_VALUES).toHaveLength(14);
    expect(DIRECT_INPUT_CTRL_KEY_VALUES).toHaveLength(26);
    expect(DIRECT_INPUT_KEY_VALUES).toHaveLength(40);
    expect(new Set(DIRECT_INPUT_KEY_VALUES).size).toBe(40);
  });

  it('Ctrl キーは C-a から C-z まで順に並ぶ', () => {
    const expected = Array.from({ length: 26 }, (_, i) => `C-${String.fromCharCode(97 + i)}`);
    expect([...DIRECT_INPUT_CTRL_KEY_VALUES]).toEqual(expected);
  });

  it.each(['F1', 'C-A', 'C-1', 'C-aa', 'M-a', 'Space', '', 'rm -rf /'])(
    'isDirectInputKey は %j を拒む',
    (value) => {
      expect(isDirectInputKey(value)).toBe(false);
    },
  );

  it('isDirectInputKey は文字列以外を拒む', () => {
    for (const value of [null, undefined, 1, {}, ['C-a']]) {
      expect(isDirectInputKey(value)).toBe(false);
    }
  });
});

describe('[#2764] isDirectInputEvent', () => {
  it('key と text の 2 形だけを受け付ける', () => {
    expect(isDirectInputEvent({ type: 'key', key: 'C-a' })).toBe(true);
    expect(isDirectInputEvent({ type: 'text', text: 'a' })).toBe(true);
    expect(isDirectInputEvent({ type: 'text', text: 'x'.repeat(MAX_DIRECT_INPUT_TEXT_LENGTH) })).toBe(true);
  });

  it.each([
    ['未知のキー', { type: 'key', key: 'F1' }],
    ['空の text', { type: 'text', text: '' }],
    ['長すぎる text', { type: 'text', text: 'x'.repeat(MAX_DIRECT_INPUT_TEXT_LENGTH + 1) }],
    ['text が文字列でない', { type: 'text', text: 1 }],
    ['未知の type', { type: 'paste', text: 'a' }],
    ['null', null],
    ['文字列', 'C-a'],
  ])('%s は拒む', (_name, value) => {
    expect(isDirectInputEvent(value)).toBe(false);
  });
});

describe('[#2764] encodeKeyEvent', () => {
  it.each([
    ['a', {}, { type: 'text', text: 'a' }],
    ['A', { shiftKey: true }, { type: 'text', text: 'A' }],
    [' ', {}, { type: 'text', text: ' ' }],
    [';', {}, { type: 'text', text: ';' }],
    ['あ', {}, { type: 'text', text: 'あ' }],
    ['😀', {}, { type: 'text', text: '😀' }],
    ['Enter', {}, { type: 'key', key: 'Enter' }],
    ['Escape', {}, { type: 'key', key: 'Escape' }],
    ['Backspace', {}, { type: 'key', key: 'BSpace' }],
    ['Delete', {}, { type: 'key', key: 'DC' }],
    ['ArrowUp', {}, { type: 'key', key: 'Up' }],
    ['ArrowDown', {}, { type: 'key', key: 'Down' }],
    ['ArrowLeft', {}, { type: 'key', key: 'Left' }],
    ['ArrowRight', {}, { type: 'key', key: 'Right' }],
    ['Home', {}, { type: 'key', key: 'Home' }],
    ['End', {}, { type: 'key', key: 'End' }],
    ['PageUp', {}, { type: 'key', key: 'PageUp' }],
    ['PageDown', {}, { type: 'key', key: 'PageDown' }],
    ['Tab', {}, { type: 'key', key: 'Tab' }],
    ['Tab', { shiftKey: true }, { type: 'key', key: 'BTab' }],
    ['a', { ctrlKey: true }, { type: 'key', key: 'C-a' }],
    ['A', { ctrlKey: true, shiftKey: true }, { type: 'key', key: 'C-a' }],
    ['z', { ctrlKey: true }, { type: 'key', key: 'C-z' }],
  ] as const)('%j + %j を送る', (key, modifiers, expected) => {
    expect(press(key, modifiers)).toEqual(expected);
  });

  it.each([
    ['1', { ctrlKey: true }],
    ['Enter', { ctrlKey: true }],
    ['Tab', { ctrlKey: true }],
    ['c', { metaKey: true }],
    ['v', { metaKey: true }],
    ['å', { altKey: true }],
    ['a', { isComposing: true }],
    ['Shift', { shiftKey: true }],
    ['Control', { ctrlKey: true }],
    ['F5', {}],
    ['Dead', {}],
    ['Process', {}],
    ['Unidentified', {}],
  ] as const)('%j + %j はブラウザに任せる（null）', (key, modifiers) => {
    expect(press(key, modifiers)).toBeNull();
  });

  it('返した key は必ず語彙の中にある', () => {
    for (const domKey of ['Enter', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'Home', 'PageDown', 'Tab']) {
      const event = press(domKey);
      expect(event?.type).toBe('key');
      expect(event?.type === 'key' ? isDirectInputKey(event.key) : false).toBe(true);
    }
  });
});
