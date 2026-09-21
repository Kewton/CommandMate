/**
 * IME が処理中のキー（keyCode 229）は、isComposing が false でもブラウザに任せる（Issue #2801）
 *
 * 旧い Safari（WebKit 310826@main より前）は、変換を確定する Enter の keydown を
 * compositionend の後に isComposing: false で送る。isComposing だけを見ていると、
 * その Enter を { type: 'key', key: 'Enter' } にしてペインへ送ってしまう。
 */
import { describe, it, expect } from 'vitest';
import { encodeKeyEvent, type KeyEventLike } from '@/types/direct-input';

const press = (key: string, fields: Partial<KeyEventLike> = {}) =>
  encodeKeyEvent({
    key,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...fields,
  });

describe('[#2801] keyCode 229', () => {
  it('旧い Safari の確定 Enter（keyCode 229 / isComposing: false）は null', () => {
    expect(press('Enter', { keyCode: 229, isComposing: false })).toBeNull();
  });

  it.each([
    ['Enter', { keyCode: 229 }],
    ['Process', { keyCode: 229 }],
    ['a', { keyCode: 229 }],
    ['Backspace', { keyCode: 229 }],
    ['ArrowDown', { keyCode: 229 }],
    ['Escape', { keyCode: 229 }],
    ['Tab', { keyCode: 229 }],
    ['a', { keyCode: 229, ctrlKey: true }],
    ['Enter', { keyCode: 229, isComposing: true }],
  ] as const)('%j + %j はブラウザに任せる（null）', (key, fields) => {
    expect(press(key, fields)).toBeNull();
  });

  it.each([
    ['Enter', { keyCode: 13 }, { type: 'key', key: 'Enter' }],
    ['a', { keyCode: 65 }, { type: 'text', text: 'a' }],
    ['a', { keyCode: 65, ctrlKey: true }, { type: 'key', key: 'C-a' }],
    ['Escape', { keyCode: 27 }, { type: 'key', key: 'Escape' }],
    ['Enter', { keyCode: 0 }, { type: 'key', key: 'Enter' }],
    ['Enter', {}, { type: 'key', key: 'Enter' }],
  ] as const)('229 以外の %j + %j は従来どおり送る', (key, fields, expected) => {
    expect(press(key, fields)).toEqual(expected);
  });
});
