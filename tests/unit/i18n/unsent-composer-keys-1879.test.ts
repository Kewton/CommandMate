/**
 * Real-dictionary i18n guard for the unsent-input bar (Issue #1879).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key present in `en`
 * and missing from `ja` renders the raw key string in production. The component
 * tests resolve keys through the `next-intl` mock in `tests/setup.ts`, which
 * returns the key itself and therefore passes for a key that exists in no
 * dictionary at all — this file is what makes those tests mean something.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/** Every key `UnsentComposerBar` resolves, as a literal. */
const KEYS = [
  'unsentComposer.regionLabel',
  'unsentComposer.label',
  'unsentComposer.run',
  'unsentComposer.clear',
] as const;

function load(locale: string): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  );
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

describe('unsent-input bar i18n keys (Issue #1879)', () => {
  it.each(LOCALES)('%s carries every key the bar resolves', (locale) => {
    const dict = load(locale);
    for (const key of KEYS) {
      const value = resolve(dict, key);
      expect(value, `${locale}/worktree.json is missing ${key}`).toBeTypeOf('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('en and ja declare exactly the same set of keys', () => {
    const keysOf = (locale: string): string[] => {
      const section = resolve(load(locale), 'unsentComposer') as Record<string, unknown>;
      return Object.keys(section).sort();
    };
    expect(keysOf('ja')).toEqual(keysOf('en'));
  });

  it('does not call the text a recommendation in either locale', () => {
    // Design constraint 1 of the Issue: nothing in the frame says whether the
    // agent pre-filled the box or a human typed half a sentence and left. The
    // label must stay neutral, and a translation is the easiest place to lose
    // that.
    for (const locale of LOCALES) {
      const label = resolve(load(locale), 'unsentComposer.label') as string;
      expect(label.toLowerCase()).not.toMatch(/recommend|suggest/);
      expect(label).not.toMatch(/推奨|提案/);
    }
  });
});
