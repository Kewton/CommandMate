/**
 * Real-dictionary i18n guard for the opencode sidebar notice (Issue #2095).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a key present in `en`
 * and missing from `ja` renders the raw key string in production. The component
 * test resolves keys through the `next-intl` mock in `tests/setup.ts`, which
 * returns the key itself and therefore passes for a key that exists in no
 * dictionary at all — this file is what makes that test mean something.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { OPENCODE_SIDEBAR_RECOVERY_CHORD } from '@/lib/detection/opencode-pane-obstruction';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/** Every key `OpencodeSidebarNotice` resolves, as a literal. */
const KEYS = [
  'opencodeSidebar.regionLabel',
  'opencodeSidebar.label',
  'opencodeSidebar.body',
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

describe('opencode sidebar notice i18n keys (Issue #2095)', () => {
  it.each(LOCALES)('%s carries every key the notice resolves', (locale) => {
    const dict = load(locale);
    for (const key of KEYS) {
      const value = resolve(dict, key);
      expect(value, `${locale}/worktree.json is missing ${key}`).toBeTypeOf('string');
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('en and ja declare exactly the same set of keys', () => {
    const keysOf = (locale: string): string[] => {
      const section = resolve(load(locale), 'opencodeSidebar') as Record<string, unknown>;
      return Object.keys(section).sort();
    };
    expect(keysOf('ja')).toEqual(keysOf('en'));
  });

  it('leaves the keystroke to the component, in both locales', () => {
    // The chord is physical key notation in opencode's own spelling and is
    // rendered from OPENCODE_SIDEBAR_RECOVERY_CHORD. A translation that spelled
    // it out again would be a second place for it to drift, and the Japanese one
    // would be the copy nobody re-checks after an upstream keybind change.
    for (const locale of LOCALES) {
      const body = resolve(load(locale), 'opencodeSidebar.body') as string;
      expect(body).not.toContain(OPENCODE_SIDEBAR_RECOVERY_CHORD);
      // …but it must still point at the key that follows it.
      expect(body.trim().endsWith(':')).toBe(true);
    }
  });
});
