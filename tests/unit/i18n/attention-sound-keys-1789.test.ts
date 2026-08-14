/**
 * i18n parity for the wording Issue #1789 added.
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key present in one
 * locale and missing in the other renders the raw key string in production and
 * nothing fails. Pinned by name, mirroring the #1788 suite next to this file.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const KEYS = ['inApp.soundToggle', 'inApp.soundToggleDesc'];

describe('Issue #1789 i18n keys exist in both dictionaries', () => {
  for (const locale of LOCALES) {
    it(`${locale}/notifications.json has ${KEYS.join(', ')}`, () => {
      const dict = load(locale, 'notifications');
      for (const key of KEYS) {
        const value = resolve(dict, key);
        expect(typeof value, `${locale}/notifications: ${key}`).toBe('string');
        expect((value as string).length, `${locale}/notifications: ${key}`).toBeGreaterThan(0);
      }
    });
  }

  it('en and ja are not the same string (an untranslated copy is a missing translation)', () => {
    for (const key of KEYS) {
      expect(resolve(load('en', 'notifications'), key)).not.toBe(
        resolve(load('ja', 'notifications'), key),
      );
    }
  });

  it('keeps the #1788 in-app keys intact alongside them', () => {
    // The sound toggle is a pure addition to the same `inApp` block; deleting a
    // sibling while adding it would be the plausible accident.
    for (const locale of LOCALES) {
      const dict = load(locale, 'notifications');
      for (const key of ['inApp.heading', 'inApp.waitingToggle', 'inApp.waitingToast']) {
        expect(typeof resolve(dict, key), `${locale}: ${key}`).toBe('string');
      }
    }
  });
});
