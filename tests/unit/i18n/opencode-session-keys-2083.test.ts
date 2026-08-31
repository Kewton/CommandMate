/**
 * Real-dictionary i18n guard for the opencode session controls (Issue #2083).
 *
 * The labels used to live in a `const LABELS = { en, ja }` map inside
 * `OpencodeSessionControls.tsx`; Issues #2051 / #2109 moved them into
 * `locales/{en,ja}/worktree.json` under `opencodeSession`. Every component test
 * for that file resolves its strings through the `next-intl` stub, which returns
 * the key itself — so those tests pass identically whether the dictionary holds
 * a translation, a copy of the key path, or nothing at all.
 *
 * This file deliberately imports no `next-intl` and mocks nothing. It reads the
 * two JSON files off disk and asserts what the stub cannot: that the keys exist
 * in both locales, that their values are real sentences rather than key paths,
 * and that `ja` is actually translated instead of an English placeholder.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');
const LOCALES = ['en', 'ja'] as const;

/** The namespace `OpencodeSessionControls` passes to `useTranslations`. */
const SECTION = 'opencodeSession';

/**
 * Every key the component resolves, as a literal. `new` / `list` / `fork` come
 * from `t(action)` over `OpencodeSessionAction`; the rest are spelled out at
 * their call sites, `errorNoSessionFork` / `errorNoSessionShare` through the
 * `noSessionKey` parameter of `failureReason`.
 */
const KEYS = [
  'new',
  'list',
  'fork',
  'share',
  'unshare',
  'shareCopy',
  'shareConfirmTitle',
  'shareConfirmBody',
  'shareConfirmLabel',
  'sharePublicNotice',
  'errorNoPort',
  'errorNoSessionFork',
  'errorNoSessionShare',
  'errorRequestFailed',
  'errorUnknown',
  'errorCopyFailed',
] as const;

/**
 * The labels that reach the screen as button text. A key path leaking here is
 * the failure Issue #2083 is about: the user sees `new` on a toolbar button.
 */
const VISIBLE_LABELS = ['new', 'list', 'fork', 'share'] as const;

function section(locale: string): Record<string, unknown> {
  const dict = JSON.parse(
    fs.readFileSync(path.join(LOCALES_DIR, locale, 'worktree.json'), 'utf-8'),
  ) as Record<string, unknown>;
  return (dict[SECTION] ?? {}) as Record<string, unknown>;
}

describe('opencode session controls i18n keys (Issue #2083)', () => {
  it.each(LOCALES)('%s carries every key the controls resolve', (locale) => {
    const dict = section(locale);
    for (const key of KEYS) {
      const value = dict[key];
      expect(value, `${locale}/worktree.json is missing ${SECTION}.${key}`).toBeTypeOf(
        'string',
      );
      expect((value as string).trim().length).toBeGreaterThan(0);
    }
  });

  it('en and ja declare exactly the same set of keys', () => {
    const keysOf = (locale: string): string[] => Object.keys(section(locale)).sort();
    expect(keysOf('ja')).toEqual(keysOf('en'));
  });

  it('declares no key beyond the ones the component resolves', () => {
    // Keeps the list above honest: a key added to the dictionary without a call
    // site is either dead weight or a call site this guard has stopped covering.
    expect(Object.keys(section('en')).sort()).toEqual([...KEYS].sort());
  });

  it.each(LOCALES)('%s holds sentences, not key paths', (locale) => {
    const dict = section(locale);
    for (const key of KEYS) {
      const value = dict[key] as string;
      // What `useTranslations` renders when the key resolves to nothing, in each
      // of the three spellings next-intl and the namespace can produce.
      for (const keyPath of [key, `${SECTION}.${key}`, `worktree.${SECTION}.${key}`]) {
        expect(
          value,
          `${locale}/worktree.json: ${SECTION}.${key} is the key path, not a translation`,
        ).not.toBe(keyPath);
      }
    }
  });

  it('translates the visible labels into Japanese rather than copying English', () => {
    const en = section('en');
    const ja = section('ja');
    for (const key of VISIBLE_LABELS) {
      expect(
        ja[key],
        `ja/worktree.json: ${SECTION}.${key} is still the English string`,
      ).not.toBe(en[key]);
      // An English placeholder that differs only in punctuation would slip past
      // the check above; Japanese text has to carry kana or kanji somewhere.
      expect(
        ja[key] as string,
        `ja/worktree.json: ${SECTION}.${key} carries no Japanese`,
      ).toMatch(/[぀-ヿ一-鿿]/);
    }
  });
});
