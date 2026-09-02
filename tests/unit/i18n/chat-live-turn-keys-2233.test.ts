/**
 * Real-dictionary i18n guard for the live tail (Issue #2233).
 *
 * Same standing as `chat-surface-keys-2194.test.ts` and
 * `chat-surface-progress-keys-2199.test.ts`, and it exists for the same reason:
 * the global next-intl mock in `tests/setup.ts` echoes the key back, so every
 * component assertion in this Issue's suites stays green with the string missing
 * from `locales/`. `src/i18n.ts` has no `getMessageFallback`, so in production
 * the chip's accessible name would be the literal
 * `chatSurface.jumpToLatestGenerating` — read aloud, verbatim, to the one reader
 * who cannot see the spinner it is standing in for.
 *
 * The key is what pays for Issue #2233's trade: the live bubble sits at the end
 * of the scrolled content (so completing a turn moves nothing), which means
 * scrolling up carries it off screen, which means the chip is the only thing
 * left saying a turn is running. Silent in one locale is the feature missing in
 * that locale.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/** The keys the live tail and its chip request at runtime. */
const LIVE_TURN_KEYS = [
  // The chip, while a turn is running and the reader is not at the end.
  'jumpToLatestGenerating',
  // Reused verbatim by `ChatLiveTurnBubble` — the bubble's accessible name, its
  // status sentence, and the "shown from the middle" badge.
  'progressLabel',
  'generating',
  'thinking',
  'progressPartial',
];

function loadChatSurface(locale: string): Record<string, string> {
  const dict = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
  return dict.chatSurface as Record<string, string>;
}

describe('[#2233] worktree.chatSurface live-tail i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the live tail requests`, () => {
      const section = loadChatSurface(locale);
      for (const key of LIVE_TURN_KEYS) {
        expect(section?.[key], `${locale}: chatSurface.${key}`).toBeTypeOf('string');
        expect(
          String(section?.[key]).trim().length,
          `${locale}: chatSurface.${key}`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the generating chip distinct from the idle one`, () => {
      // Collapsing the two would make the chip say the same thing whether or not
      // a turn is running — which is the whole information it carries.
      const section = loadChatSurface(locale);
      expect(section.jumpToLatestGenerating).not.toBe(section.jumpToLatest);
    });
  }

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(loadChatSurface('ja').jumpToLatestGenerating)).toBe(true);
    expect(isJapanese(loadChatSurface('en').jumpToLatestGenerating)).toBe(false);
  });
});
