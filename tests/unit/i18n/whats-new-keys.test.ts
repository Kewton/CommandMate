/**
 * Real-dictionary i18n guard for the `common.whatsNew` namespace (Issue #2651).
 *
 * The global next-intl mock (tests/setup.ts) echoes the requested key back, so
 * a component test can render "common.whatsNew.title" at the user and still be
 * green. Only this file reads the shipped dictionaries, so it is the sole thing
 * standing between a typo'd key and the What's-new dialog showing key paths.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadCommon(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'common.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)?.[part], dict);
}

/** Every `whatsNew.*` key WhatsNewDialog requests at runtime. */
const WHATS_NEW_KEYS = [
  'title',
  'highlight',
  'added',
  'improved',
  'fixed',
  'empty',
  'releaseLink',
  'close',
];

describe('common.whatsNew i18n keys (Issue #2651)', () => {
  it.each(['en', 'ja'])('%s resolves every whatsNew key the dialog requests', (locale) => {
    const dict = loadCommon(locale);
    for (const key of WHATS_NEW_KEYS) {
      const value = resolve(dict, `whatsNew.${key}`);
      expect(typeof value, `${locale}: whatsNew.${key} must be a string`).toBe('string');
      expect((value as string).trim(), `${locale}: whatsNew.${key} is empty`).not.toBe('');
    }
  });

  /**
   * Copy/pasting the English block into ja/ would leave the dialog English for
   * Japanese users while the parity check below still passed.
   */
  it('translates every whatsNew string rather than leaving it in English', () => {
    const en = loadCommon('en');
    const ja = loadCommon('ja');
    for (const key of WHATS_NEW_KEYS) {
      expect(
        resolve(ja, `whatsNew.${key}`),
        `ja: whatsNew.${key} is still the English string`
      ).not.toBe(resolve(en, `whatsNew.${key}`));
    }
  });

  /**
   * The title is the only interpolated string. A locale that dropped a
   * placeholder would render "What's new (v → v)".
   */
  it('keeps the {from} and {to} placeholders in both locales', () => {
    for (const locale of ['en', 'ja']) {
      const title = resolve(loadCommon(locale), 'whatsNew.title') as string;
      expect(title, `${locale}: whatsNew.title lost {from}`).toContain('{from}');
      expect(title, `${locale}: whatsNew.title lost {to}`).toContain('{to}');
    }
  });

  it('en and ja expose the identical set of whatsNew keys (parity)', () => {
    const en = Object.keys(loadCommon('en').whatsNew as Record<string, unknown>).sort();
    const ja = Object.keys(loadCommon('ja').whatsNew as Record<string, unknown>).sort();
    expect(en).toEqual(ja);
    expect(en).toEqual([...WHATS_NEW_KEYS].sort());
  });
});
