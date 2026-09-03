/**
 * Real-dictionary i18n guard for the maximize/restore controls (Issue #2261).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so the component tests above stay green with every key missing from
 * `locales/`. `src/i18n.ts` has no `onError` and no `getMessageFallback`, so a
 * missing key ships as the literal `terminal.maximizeSplit` — as the
 * `aria-label` and `title` of an ICON-ONLY button, which is the only thing
 * naming it. This file is what stands between those two facts.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function terminalSection(locale: string): Record<string, string> {
  const dict = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
  return dict.terminal as Record<string, string>;
}

/** Every key the two maximize toggles + the split-count label request. */
const MAXIMIZE_KEYS = [
  'maximizeSplit',
  'maximizeFocusedSplit',
  'restoreSplits',
  'maximizeShortcutHint',
  'maximizedStatus',
];

/** Keys whose message MUST carry an interpolation placeholder. */
const PLACEHOLDERS: Record<string, string[]> = {
  maximizeSplit: ['{split}'],
  maximizedStatus: ['{split}'],
};

describe('[#2261] worktree.terminal maximize i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every maximize key the controls request`, () => {
      const section = terminalSection(locale);
      for (const key of MAXIMIZE_KEYS) {
        expect(section[key], `${locale}: terminal.${key}`).toBeTypeOf('string');
        expect(section[key].trim().length, `${locale}: terminal.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the interpolation placeholders`, () => {
      const section = terminalSection(locale);
      for (const [key, tokens] of Object.entries(PLACEHOLDERS)) {
        for (const token of tokens) {
          expect(section[key], `${locale}: terminal.${key}`).toContain(token);
        }
      }
    });

    it(`${locale} names the chord the keyboard handler actually listens for`, () => {
      // The tooltip is the only place the binding is advertised, so a hint that
      // drifts from `TerminalSplitPaneContent`'s listener is worse than none.
      const hint = terminalSection(locale).maximizeShortcutHint;
      expect(hint).toContain('Shift');
      expect(hint).toContain('Enter');
      expect(hint).toContain('Ctrl');
    });
  }

  it('does not leave an English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    // `maximizeShortcutHint` is deliberately excluded: key caps are the same
    // glyphs in both languages.
    for (const key of ['maximizeFocusedSplit', 'restoreSplits']) {
      expect(isJapanese(terminalSection('ja')[key]), `ja: terminal.${key}`).toBe(true);
      expect(isJapanese(terminalSection('en')[key]), `en: terminal.${key}`).toBe(false);
    }
  });

  it('en and ja declare exactly the same terminal keys', () => {
    expect(Object.keys(terminalSection('ja')).sort()).toEqual(
      Object.keys(terminalSection('en')).sort(),
    );
  });
});
