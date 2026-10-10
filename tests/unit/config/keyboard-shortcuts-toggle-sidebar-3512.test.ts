/**
 * @vitest-environment jsdom
 */

/**
 * Mod+B opens / closes the sidebar (Issue #3512): registered for the `?`
 * overlay, and clear of every other chord the app lists or binds.
 */

import { describe, it, expect } from 'vitest';
import { KEYBOARD_SHORTCUTS, MOD_KEY_TOKEN } from '@/config/keyboard-shortcuts';
import { NEW_TASK_SHORTCUTS, isOpenNewTaskChord } from '@/lib/new-task/new-task-shortcut';
import { isToggleSidebarChord, isSidebarShortcutBlockedTarget } from '@/lib/sidebar-utils';

/** Every row the `?` overlay lists (central registry + New task). */
const ALL_LISTED = [...KEYBOARD_SHORTCUTS, ...NEW_TASK_SHORTCUTS];

/** Normalised chord: modifiers sorted, keys upper-cased. */
function chordOf(keys: readonly string[]): string {
  return keys.map((k) => k.toUpperCase()).sort().join('+');
}

function keyEvent(init: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: 'b',
    code: 'KeyB',
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    isComposing: false,
    keyCode: 66,
    ...init,
  } as KeyboardEvent;
}

describe('toggleSidebar shortcut (Issue #3512)', () => {
  it('is registered as Mod+B in the global scope', () => {
    const row = KEYBOARD_SHORTCUTS.find((s) => s.id === 'toggleSidebar');
    expect(row).toEqual({ id: 'toggleSidebar', keys: [MOD_KEY_TOKEN, 'B'], scope: 'global' });
  });

  it('shares its key combination with no other listed shortcut', () => {
    const mine = chordOf([MOD_KEY_TOKEN, 'B']);
    const others = ALL_LISTED.filter((s) => s.id !== 'toggleSidebar').map((s) => chordOf(s.keys));
    expect(others).not.toContain(mine);
  });

  it('no two listed shortcuts in overlapping scopes share a combination', () => {
    // A global chord collides with every scope; scoped chords only with their own.
    for (const [i, a] of ALL_LISTED.entries()) {
      for (const b of ALL_LISTED.slice(i + 1)) {
        const overlap = a.scope === 'global' || b.scope === 'global' || a.scope === b.scope;
        if (!overlap) continue;
        expect(chordOf(a.keys), `${a.id} vs ${b.id}`).not.toBe(chordOf(b.keys));
      }
    }
  });

  it('matches Mod+B with either modifier, and the B key on non-Latin layouts', () => {
    expect(isToggleSidebarChord(keyEvent({ metaKey: true }))).toBe(true);
    expect(isToggleSidebarChord(keyEvent({ ctrlKey: true }))).toBe(true);
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, key: 'и' }))).toBe(true);
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, key: 'B' }))).toBe(true);
  });

  it('does not match the neighbours it must leave alone', () => {
    // Bookmarks bar, plain B, Alt, IME composition.
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, shiftKey: true }))).toBe(false);
    expect(isToggleSidebarChord(keyEvent({}))).toBe(false);
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, altKey: true }))).toBe(false);
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, isComposing: true }))).toBe(false);
    expect(isToggleSidebarChord(keyEvent({ metaKey: true, keyCode: 229 }))).toBe(false);
    // The other registered Mod chords.
    for (const key of ['k', 'f', 's', 'm']) {
      expect(isToggleSidebarChord(keyEvent({ metaKey: true, key, code: `Key${key.toUpperCase()}` }))).toBe(false);
    }
  });

  it('is not the New task chord, and New task is not this one', () => {
    const newTask = keyEvent({ metaKey: true, shiftKey: true, key: 'o', code: 'KeyO' });
    expect(isOpenNewTaskChord(newTask)).toBe(true);
    expect(isToggleSidebarChord(newTask)).toBe(false);
    expect(isOpenNewTaskChord(keyEvent({ metaKey: true }))).toBe(false);
  });
});

describe('isSidebarShortcutBlockedTarget (Issue #3512)', () => {
  it('blocks text entry and the terminal pane', () => {
    const input = document.createElement('input');
    const textarea = document.createElement('textarea');
    const select = document.createElement('select');
    const log = document.createElement('div');
    log.setAttribute('role', 'log');
    const inLog = document.createElement('span');
    log.appendChild(inLog);
    for (const el of [input, textarea, select, log, inLog]) {
      expect(isSidebarShortcutBlockedTarget(el)).toBe(true);
    }
  });

  it('lets the shortcut through elsewhere', () => {
    expect(isSidebarShortcutBlockedTarget(document.body)).toBe(false);
    expect(isSidebarShortcutBlockedTarget(document.createElement('button'))).toBe(false);
    expect(isSidebarShortcutBlockedTarget(null)).toBe(false);
  });
});
