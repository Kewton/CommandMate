/**
 * Real-dictionary i18n guard for the dialog card (Issue #2254).
 *
 * Same standing hazard as `chat-surface-keys-2194.test.ts`: the global next-intl
 * mock in `tests/setup.ts` echoes the requested key back, so every component
 * test of the card stays green with the whole section missing from `locales/`,
 * and `src/i18n.ts` has neither `onError` nor `getMessageFallback` — a missing
 * key renders as the literal `worktree.promptAnswerKeys.caption`, on a control
 * whose entire job is to tell someone which key answers the dialog in front of
 * them.
 *
 * The wording assertions are #2254's own. Epic #2192's decision 5 said the four
 * blocked frames were terminal-only and the four `reason*` sentences ENDED by
 * sending the reader away ("…はターミナル面で操作してください" /
 * "…from the terminal surface"). That decision is withdrawn: the card is on
 * screen, the keys are under it, and a sentence that still says "go to the
 * terminal" would be actively wrong about what the user is looking at. So the
 * old wording is asserted GONE, not merely "the keys exist".
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadWorktree(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'));
}

/** Keys `ChatSurface` / `ChatDialogCard` request at runtime because of #2254. */
const CHAT_SURFACE_KEYS = ['dialogCardLabel', 'unreadableHint', 'bannerLabel'];

/** Keys `PromptAnswerKeys` requests. Its key CAPS are physical notation, not prose. */
const ANSWER_KEY_SECTION_KEYS = ['toolbarLabel', 'caption'];

const REASON_KEYS = [
  'reasonPager',
  'reasonSelectionList',
  'reasonUnclassified',
  'reasonPromptUnreadable',
];

/**
 * Phrases that only made sense while decision 5 stood.
 *
 * Matched case-insensitively against the four reason sentences AND the banner
 * label — the label used to read 「ターミナルでの操作が必要です」 / "Needs the
 * terminal", which is the claim #2254 falsified.
 */
const WITHDRAWN_PHRASES: ReadonlyArray<{ locale: string; phrase: string }> = [
  { locale: 'ja', phrase: 'ターミナル面で操作してください' },
  { locale: 'ja', phrase: 'ターミナル面で確認してください' },
  { locale: 'ja', phrase: 'ターミナルでの操作が必要です' },
  { locale: 'en', phrase: 'from the terminal surface' },
  { locale: 'en', phrase: 'on the terminal surface' },
  { locale: 'en', phrase: 'needs the terminal' },
];

describe('[#2254] worktree i18n for the dialog card', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every chatSurface key the card requests`, () => {
      const section = loadWorktree(locale).chatSurface;
      for (const key of CHAT_SURFACE_KEYS) {
        expect(section?.[key], `${locale}: chatSurface.${key}`).toBeTypeOf('string');
        expect(String(section?.[key]).trim().length).toBeGreaterThan(0);
      }
    });

    it(`${locale} defines the promptAnswerKeys section`, () => {
      const section = loadWorktree(locale).promptAnswerKeys;
      expect(section, `${locale}: worktree.promptAnswerKeys`).toBeTypeOf('object');
      for (const key of ANSWER_KEY_SECTION_KEYS) {
        expect(section?.[key], `${locale}: promptAnswerKeys.${key}`).toBeTypeOf('string');
        expect(String(section?.[key]).trim().length).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the openTerminal button — it is a secondary way out, not deleted`, () => {
      // #2254 demoted this control; it did not remove it. Someone who wants the
      // whole pane (scrollback, search, rows the card's 12-20 cut off) still has
      // one tap to it.
      const section = loadWorktree(locale).chatSurface;
      expect(section.openTerminal).toBeTypeOf('string');
      expect(section.openTerminal.trim().length).toBeGreaterThan(0);
    });

    it(`${locale} still words each blocked reason differently`, () => {
      const section = loadWorktree(locale).chatSurface;
      const sentences = REASON_KEYS.map((key) => section[key]);
      expect(new Set(sentences).size).toBe(REASON_KEYS.length);
    });
  }

  it('no longer tells the reader to go to the terminal to act', () => {
    for (const { locale, phrase } of WITHDRAWN_PHRASES) {
      const section = loadWorktree(locale).chatSurface;
      for (const key of [...REASON_KEYS, 'bannerLabel']) {
        expect(
          section[key].toLowerCase(),
          `${locale}: chatSurface.${key} still carries the withdrawn decision-5 wording "${phrase}"`,
        ).not.toContain(phrase.toLowerCase());
      }
    }
  });

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(loadWorktree('ja').promptAnswerKeys.caption)).toBe(true);
    expect(isJapanese(loadWorktree('en').promptAnswerKeys.caption)).toBe(false);
    expect(isJapanese(loadWorktree('ja').chatSurface.dialogCardLabel)).toBe(true);
    expect(isJapanese(loadWorktree('en').chatSurface.dialogCardLabel)).toBe(false);
  });

  it('en and ja declare exactly the same keys in both touched sections', () => {
    for (const section of ['chatSurface', 'promptAnswerKeys']) {
      expect(Object.keys(loadWorktree('ja')[section]).sort(), section).toEqual(
        Object.keys(loadWorktree('en')[section]).sort(),
      );
    }
  });
});
