/**
 * Tests for the keyboard-shortcuts registry (Issue #1130).
 */

import { describe, it, expect } from 'vitest';
import {
  KEYBOARD_SHORTCUTS,
  SHORTCUT_SCOPES,
  MOD_KEY_TOKEN,
  groupShortcutsByScope,
  resolveShortcutKey,
  type ShortcutScope,
} from '@/config/keyboard-shortcuts';

describe('keyboard-shortcuts registry', () => {
  it('has unique, non-empty shortcut ids', () => {
    const ids = KEYBOARD_SHORTCUTS.map((s) => s.id);
    expect(ids.every((id) => id.length > 0)).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every shortcut has at least one key and a known scope', () => {
    for (const shortcut of KEYBOARD_SHORTCUTS) {
      expect(shortcut.keys.length).toBeGreaterThan(0);
      expect(SHORTCUT_SCOPES).toContain(shortcut.scope);
    }
  });

  it('registers the command-palette, help, terminal-search and composer bindings', () => {
    const ids = KEYBOARD_SHORTCUTS.map((s) => s.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'commandPalette',
        'keyboardHelp',
        'terminalSearch',
        'sendMessage',
        'composerNewline',
      ]),
    );
  });

  describe('groupShortcutsByScope', () => {
    it('groups shortcuts under their scope in SHORTCUT_SCOPES order', () => {
      const groups = groupShortcutsByScope();
      const scopes = groups.map((g) => g.scope);
      // Order matches SHORTCUT_SCOPES (filtered to non-empty).
      expect(scopes).toEqual(SHORTCUT_SCOPES.filter((s) => scopes.includes(s)));
    });

    it('covers every registered shortcut exactly once', () => {
      const grouped = groupShortcutsByScope().flatMap((g) => g.shortcuts);
      expect(grouped).toHaveLength(KEYBOARD_SHORTCUTS.length);
      expect(new Set(grouped.map((s) => s.id)).size).toBe(KEYBOARD_SHORTCUTS.length);
    });

    it('drops scopes that have no shortcuts', () => {
      const single = groupShortcutsByScope([
        { id: 'x', keys: ['X'], scope: 'terminal' as ShortcutScope },
      ]);
      expect(single).toHaveLength(1);
      expect(single[0].scope).toBe('terminal');
    });
  });

  describe('resolveShortcutKey', () => {
    it('renders the mod token as ⌘ on macOS and Ctrl elsewhere', () => {
      expect(resolveShortcutKey(MOD_KEY_TOKEN, true)).toBe('⌘');
      expect(resolveShortcutKey(MOD_KEY_TOKEN, false)).toBe('Ctrl');
    });

    it('passes plain keys through unchanged', () => {
      expect(resolveShortcutKey('K', true)).toBe('K');
      expect(resolveShortcutKey('?', false)).toBe('?');
    });
  });
});
