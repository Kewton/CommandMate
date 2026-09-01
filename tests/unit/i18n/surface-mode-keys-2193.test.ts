/**
 * Real-dictionary i18n guard for the surface-mode UI (Issue #2193).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the component tests stay green even with every key missing from
 * `locales/`. `src/i18n.ts` has no `onError` and no `getMessageFallback`, so in
 * production a missing key renders as the literal `surfaceMode.showChat` — as
 * the `aria-label` and `title` of an icon-only button, which are the ONLY thing
 * naming it. This file is what stands between those two facts.
 *
 * It also pins the keyboard shortcut, for the same reason: the `?` overlay is
 * the discoverability surface the Epic requires, and it renders
 * `t('shortcuts.<id>')` off the registry with no fallback of its own.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { KEYBOARD_SHORTCUTS, MOD_KEY_TOKEN } from '@/config/keyboard-shortcuts';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, file: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, file), 'utf-8'));
}

/** Every `surfaceMode.*` key the two toggles request at runtime. */
const SURFACE_MODE_KEYS = [
  'groupLabel',
  'groupLabelMobile',
  'terminal',
  'chat',
  'showTerminal',
  'showChat',
  'chatSurfaceLabel',
];

/** Keys whose message MUST carry an interpolation placeholder. */
const PLACEHOLDERS: Record<string, string[]> = {
  groupLabel: ['{split}'],
};

describe('[#2193] worktree.surfaceMode i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every surfaceMode key the toggles request`, () => {
      const dict = load(locale, 'worktree.json');
      const section = dict.surfaceMode as Record<string, unknown> | undefined;
      expect(section, `${locale}: worktree.surfaceMode`).toBeTypeOf('object');
      for (const key of SURFACE_MODE_KEYS) {
        const value = section?.[key];
        expect(value, `${locale}: surfaceMode.${key}`).toBeTypeOf('string');
        expect(String(value).trim().length, `${locale}: surfaceMode.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the interpolation placeholders`, () => {
      const section = load(locale, 'worktree.json').surfaceMode as Record<string, string>;
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        for (const token of tokens) {
          expect(section[key], `${locale}: surfaceMode.${key}`).toContain(token);
        }
      }
    });

    it(`${locale} does not leave an English string in the ja dictionary (or vice versa)`, () => {
      const section = load(locale, 'worktree.json').surfaceMode as Record<string, string>;
      const hasJapanese = /[぀-ヿ一-龯]/.test(section.showChat);
      expect(hasJapanese, `${locale}: surfaceMode.showChat`).toBe(locale === 'ja');
    });
  }

  it('en and ja declare exactly the same surfaceMode keys', () => {
    const en = Object.keys(load('en', 'worktree.json').surfaceMode as object).sort();
    const ja = Object.keys(load('ja', 'worktree.json').surfaceMode as object).sort();
    expect(ja).toEqual(en);
  });
});

describe('[#2193] toggleSurfaceMode keyboard shortcut', () => {
  const shortcut = KEYBOARD_SHORTCUTS.find((s) => s.id === 'toggleSurfaceMode');

  it('is registered under the terminal scope so the ? overlay lists it', () => {
    expect(shortcut).toBeDefined();
    expect(shortcut?.scope).toBe('terminal');
    expect(shortcut?.keys).toEqual([MOD_KEY_TOKEN, 'Shift', 'M']);
  });

  it('does not collide with an existing binding', () => {
    // Two rows in the help overlay showing the same caps would be a lie about
    // what the app does, whichever handler happens to win.
    const bindings = KEYBOARD_SHORTCUTS.map((s) => s.keys.join('+'));
    expect(new Set(bindings).size).toBe(bindings.length);
  });

  it('is distinguishable from the editor Ctrl+M binding by Shift', () => {
    // MarkdownEditor's `editorTabFocus` (Issue #1518) is a literal Ctrl+M that
    // does not itself check Shift, so Shift is the ONLY thing separating the two
    // chords on Windows / Linux. If this ever stops holding, the guard in
    // TerminalSplitPaneContent's keydown listener has to change with it.
    const editor = KEYBOARD_SHORTCUTS.find((s) => s.id === 'editorTabFocus');
    expect(editor?.keys).toEqual(['Ctrl', 'M']);
    expect(shortcut?.keys).toContain('Shift');
  });

  for (const locale of LOCALES) {
    it(`${locale} describes the shortcut in the help overlay`, () => {
      const dict = load(locale, 'keyboardShortcuts.json');
      const shortcuts = dict.shortcuts as Record<string, unknown>;
      expect(shortcuts.toggleSurfaceMode, `${locale}: shortcuts.toggleSurfaceMode`).toBeTypeOf(
        'string',
      );
    });
  }

  it('leaves no registered shortcut without a description in either locale', () => {
    for (const locale of LOCALES) {
      const shortcuts = load(locale, 'keyboardShortcuts.json').shortcuts as Record<
        string,
        unknown
      >;
      for (const registered of KEYBOARD_SHORTCUTS) {
        expect(shortcuts[registered.id], `${locale}: shortcuts.${registered.id}`).toBeTypeOf(
          'string',
        );
      }
    }
  });
});
