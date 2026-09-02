/**
 * Real-dictionary i18n guard for the in-flight reply (Issue #2199).
 *
 * Same standing as `chat-surface-keys-2194.test.ts`, and it exists for the same
 * reason: the global next-intl mock in `tests/setup.ts` echoes the key back, so
 * every component assertion about the progress bubble stays green with both
 * strings missing from `locales/`. `src/i18n.ts` has no `getMessageFallback`, so
 * in production the accessible name of the live region would be the literal
 * `chatSurface.progressLabel` and the truncation notice would read
 * `chatSurface.progressPartial` — on a bubble whose only job is to say honestly
 * what the reader is looking at.
 *
 * A separate file from #2194's rather than an edit to it: that suite is the
 * contract for the keys #2194 shipped, and it is asserted to stay green
 * unchanged.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/** The keys `ChatSurface` requests for the progress bubble. */
const PROGRESS_KEYS = ['progressLabel', 'progressPartial'];

function loadChatSurface(locale: string): Record<string, string> {
  const dict = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
  return dict.chatSurface as Record<string, string>;
}

describe('[#2199] worktree.chatSurface progress i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every progress key the bubble requests`, () => {
      const section = loadChatSurface(locale);
      for (const key of PROGRESS_KEYS) {
        expect(section?.[key], `${locale}: chatSurface.${key}`).toBeTypeOf('string');
        expect(
          String(section?.[key]).trim().length,
          `${locale}: chatSurface.${key}`,
        ).toBeGreaterThan(0);
      }
    });

    it(`${locale} keeps the truncation notice distinct from every other line`, () => {
      // "Showing the latest part only" is a claim about the body, not a status.
      // Collapsing it into `generating` would leave the reader unable to tell a
      // complete reply from one shown from the middle.
      const section = loadChatSurface(locale);
      const others = Object.entries(section)
        .filter(([key]) => key !== 'progressPartial')
        .map(([, value]) => value);
      expect(others).not.toContain(section.progressPartial);
    });
  }

  it('leaves no English string in the ja dictionary (or vice versa)', () => {
    const isJapanese = (value: string) => /[぀-ヿ一-龯]/.test(value);
    expect(isJapanese(loadChatSurface('ja').progressPartial)).toBe(true);
    expect(isJapanese(loadChatSurface('en').progressPartial)).toBe(false);
  });
});
