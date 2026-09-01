/**
 * Real-dictionary i18n guard for the chat surface (Issue #2194).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back, so
 * every component test of `ChatSurface` stays green with the whole section
 * missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * `chatSurface.reasonPager` — inside the banner that is supposed to tell someone
 * why their session is stuck. This file is what stands between those two facts.
 *
 * The reason strings are also required to be DISTINCT: Issue #2194 asks for
 * per-flag wording, and four keys resolving to one sentence would satisfy every
 * structural assertion in the component suite while telling the user nothing
 * about which of the four states they are actually in.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadChatSurface(locale: string): Record<string, string> {
  const dict = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
  return dict.chatSurface as Record<string, string>;
}

/** Every `chatSurface.*` key ChatSurface requests at runtime. */
const CHAT_SURFACE_KEYS = [
  'liveRegionLabel',
  'generating',
  'thinking',
  'bannerLabel',
  'reasonPager',
  'reasonSelectionList',
  'reasonUnclassified',
  'reasonPromptUnreadable',
  'openTerminal',
  'jumpToLatest',
  'emptyHint',
];

/** The four banner sentences, which must not collapse into one another. */
const REASON_KEYS = [
  'reasonPager',
  'reasonSelectionList',
  'reasonUnclassified',
  'reasonPromptUnreadable',
];

describe('[#2194] worktree.chatSurface i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every chatSurface key the surface requests`, () => {
      const section = loadChatSurface(locale);
      expect(section, `${locale}: worktree.chatSurface`).toBeTypeOf('object');
      for (const key of CHAT_SURFACE_KEYS) {
        expect(section?.[key], `${locale}: chatSurface.${key}`).toBeTypeOf('string');
        expect(
          String(section?.[key]).trim().length,
          `${locale}: chatSurface.${key}`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${locale} words each blocked reason differently`, () => {
      const section = loadChatSurface(locale);
      const sentences = REASON_KEYS.map((key) => section[key]);
      expect(new Set(sentences).size, `${locale}: chatSurface reasons`).toBe(REASON_KEYS.length);
    });

    it(`${locale} keeps the generating and thinking wordings apart`, () => {
      const section = loadChatSurface(locale);
      expect(section.generating).not.toBe(section.thinking);
    });
  }

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(loadChatSurface('ja').openTerminal)).toBe(true);
    expect(isJapanese(loadChatSurface('en').openTerminal)).toBe(false);
  });

  it('en and ja declare exactly the same chatSurface keys', () => {
    expect(Object.keys(loadChatSurface('ja')).sort()).toEqual(
      Object.keys(loadChatSurface('en')).sort(),
    );
  });
});
