/**
 * i18n parity for the wording Issue #1788 added.
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key present in one
 * locale and missing in the other renders the raw key string in production and
 * nothing fails. These namespaces already have their own parity suites; this
 * file pins the specific keys, so deleting one in a single locale is caught by
 * name rather than by a diff of two sorted lists.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

function load(locale: string, namespace: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8'),
  );
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const REQUIRED: Array<{ namespace: string; keys: string[] }> = [
  { namespace: 'common', keys: ['attention.label', 'attention.badgeLabel'] },
  {
    namespace: 'notifications',
    keys: [
      'inApp.heading',
      'inApp.waitingToggle',
      'inApp.waitingToggleDesc',
      'inApp.waitingToast',
    ],
  },
  { namespace: 'home', keys: ['sessionSummary.waitingLinkLabel'] },
];

describe('Issue #1788 i18n keys exist in both dictionaries', () => {
  for (const { namespace, keys } of REQUIRED) {
    for (const locale of LOCALES) {
      it(`${locale}/${namespace}.json has ${keys.join(', ')}`, () => {
        const dict = load(locale, namespace);
        for (const key of keys) {
          const value = resolve(dict, key);
          expect(typeof value, `${locale}/${namespace}: ${key}`).toBe('string');
          expect((value as string).length, `${locale}/${namespace}: ${key}`).toBeGreaterThan(0);
        }
      });
    }
  }

  it('the interpolated keys keep their placeholders in every locale', () => {
    for (const locale of LOCALES) {
      expect(resolve(load(locale, 'common'), 'attention.badgeLabel')).toContain('{count}');
      expect(resolve(load(locale, 'notifications'), 'inApp.waitingToast')).toContain('{name}');
      expect(resolve(load(locale, 'home'), 'sessionSummary.waitingLinkLabel')).toContain('{count}');
    }
  });

  it('en and ja are not the same string (an untranslated copy is a missing translation)', () => {
    expect(resolve(load('en', 'common'), 'attention.label')).not.toBe(
      resolve(load('ja', 'common'), 'attention.label'),
    );
    expect(resolve(load('en', 'notifications'), 'inApp.waitingToggle')).not.toBe(
      resolve(load('ja', 'notifications'), 'inApp.waitingToggle'),
    );
  });
});
