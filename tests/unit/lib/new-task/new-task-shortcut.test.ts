/**
 * New task's chords (Issue #3511): Mod+Shift+O opens, Mod+Enter sends, and
 * neither collides with a chord the app already registers.
 */

import { describe, it, expect } from 'vitest';
import {
  NEW_TASK_SHORTCUTS,
  isOpenNewTaskChord,
  isSendNewTaskChord,
} from '@/lib/new-task/new-task-shortcut';
import { KEYBOARD_SHORTCUTS, MOD_KEY_TOKEN } from '@/config/keyboard-shortcuts';

function chord(init: Partial<KeyboardEvent> & { key: string }) {
  return {
    code: '',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 0,
    ...init,
  } as KeyboardEvent;
}

describe('[#3511] isOpenNewTaskChord', () => {
  it('matches Mod+Shift+O on both platforms', () => {
    expect(isOpenNewTaskChord(chord({ key: 'O', metaKey: true, shiftKey: true }))).toBe(true);
    expect(isOpenNewTaskChord(chord({ key: 'O', ctrlKey: true, shiftKey: true }))).toBe(true);
    // A layout whose O key does not type a Latin "o".
    expect(isOpenNewTaskChord(chord({ key: 'щ', code: 'KeyO', ctrlKey: true, shiftKey: true }))).toBe(true);
  });

  it('ignores the chords other features own (negative control)', () => {
    expect(isOpenNewTaskChord(chord({ key: 'k', metaKey: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'M', metaKey: true, shiftKey: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'F', metaKey: true, shiftKey: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'o', metaKey: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'O', shiftKey: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'O', metaKey: true, shiftKey: true, altKey: true }))).toBe(false);
  });

  it('ignores IME composition', () => {
    expect(isOpenNewTaskChord(chord({ key: 'O', metaKey: true, shiftKey: true, isComposing: true }))).toBe(false);
    expect(isOpenNewTaskChord(chord({ key: 'O', metaKey: true, shiftKey: true, keyCode: 229 }))).toBe(false);
  });
});

describe('[#3511] isSendNewTaskChord', () => {
  it('matches Mod+Enter', () => {
    expect(isSendNewTaskChord(chord({ key: 'Enter', metaKey: true }))).toBe(true);
    expect(isSendNewTaskChord(chord({ key: 'Enter', ctrlKey: true }))).toBe(true);
  });

  it('leaves Enter, Shift+Enter and Mod+Shift+Enter alone', () => {
    expect(isSendNewTaskChord(chord({ key: 'Enter' }))).toBe(false);
    expect(isSendNewTaskChord(chord({ key: 'Enter', shiftKey: true }))).toBe(false);
    // Mod+Shift+Enter is the split maximize (Issue #2261).
    expect(isSendNewTaskChord(chord({ key: 'Enter', metaKey: true, shiftKey: true }))).toBe(false);
    expect(isSendNewTaskChord(chord({ key: 'Enter', metaKey: true, isComposing: true }))).toBe(false);
  });
});

describe('[#3511] NEW_TASK_SHORTCUTS', () => {
  it('collides with no registered chord or id', () => {
    const signature = (keys: readonly string[]) => keys.map((k) => k.toLowerCase()).join('+');
    const registered = new Set(KEYBOARD_SHORTCUTS.map((s) => signature(s.keys)));
    const ids = new Set(KEYBOARD_SHORTCUTS.map((s) => s.id));
    for (const shortcut of NEW_TASK_SHORTCUTS) {
      expect(registered.has(signature(shortcut.keys))).toBe(false);
      expect(ids.has(shortcut.id)).toBe(false);
    }
    expect(NEW_TASK_SHORTCUTS.map((s) => s.keys)).toEqual([
      [MOD_KEY_TOKEN, 'Shift', 'O'],
      [MOD_KEY_TOKEN, '↵'],
    ]);
  });
});
