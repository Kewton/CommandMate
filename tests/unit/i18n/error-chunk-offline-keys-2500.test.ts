/**
 * Real-dictionary i18n guard for the `error.chunkOffline.*` keys (Issue #2500).
 *
 * The global next-intl mock in `tests/setup.ts` echoes the requested key back,
 * so `app/error.tsx`'s own test stays green even if every key added by this
 * Issue were missing from `locales/`. `src/i18n.ts` has no `onError` and no
 * `getMessageFallback`, so in production a missing key renders as the literal
 * string `chunkOffline.title` — on the full-screen error page a user reaches by
 * losing their connection, which is the worst possible place to ship raw keys.
 *
 * The second half of this file is the point of #2500 rather than a formality:
 * the offline copy must not describe a version update. That was the original
 * bug — a phone that dropped Wi-Fi was told a new version was available and the
 * page reloaded under it — so the words themselves are pinned here.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function loadError(locale: string): Record<string, Record<string, string>> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'error.json'), 'utf-8'));
}

/** Every `chunkOffline.*` key the boundary requests at runtime. */
const KEYS = ['title', 'description', 'waiting'];

/**
 * Words that belong to the *version update* story only. The whole point of the
 * offline copy is that it does not tell this story.
 */
const VERSION_VOCABULARY: Record<(typeof LOCALES)[number], string[]> = {
  en: ['version', 'update', 'latest'],
  ja: ['バージョン', '更新', '最新'],
};

describe('[#2500] error.chunkOffline i18n parity', () => {
  for (const locale of LOCALES) {
    it(`${locale} defines every key the offline boundary requests`, () => {
      const dict = loadError(locale);
      expect(dict.chunkOffline, `${locale}: chunkOffline namespace`).toBeTypeOf('object');
      for (const key of KEYS) {
        const value = dict.chunkOffline?.[key];
        expect(value, `${locale}: chunkOffline.${key}`).toBeTypeOf('string');
        expect((value as string).trim().length, `${locale}: chunkOffline.${key}`).toBeGreaterThan(0);
      }
    });

    it(`${locale} offline copy talks about the connection, not a new version`, () => {
      const dict = loadError(locale);
      const copy = KEYS.map((key) => dict.chunkOffline[key]).join(' ');

      for (const word of VERSION_VOCABULARY[locale]) {
        expect(copy.toLowerCase(), `${locale}: offline copy must not say "${word}"`).not.toContain(
          word.toLowerCase()
        );
      }
    });

    it(`${locale} keeps the separate version-update copy for the build case`, () => {
      const dict = loadError(locale);
      // The #1404 copy still exists and is still the version story — the fix
      // splits the two messages apart rather than replacing one with the other.
      expect(dict.chunkReload?.title, `${locale}: chunkReload.title`).toBeTypeOf('string');
      expect(dict.chunkReload?.description, `${locale}: chunkReload.description`).toBeTypeOf(
        'string'
      );
      expect(dict.chunkReload.title).not.toBe(dict.chunkOffline.title);
      expect(dict.chunkReload.description).not.toBe(dict.chunkOffline.description);
    });
  }

  it('ja and en define exactly the same chunkOffline keys', () => {
    const en = Object.keys(loadError('en').chunkOffline).sort();
    const ja = Object.keys(loadError('ja').chunkOffline).sort();
    expect(ja).toEqual(en);
  });
});
