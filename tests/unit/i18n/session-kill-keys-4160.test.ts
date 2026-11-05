/**
 * The wording a kill-session uses when its outcome is not a plain yes or no (Issue
 * #4160), in both languages, with the same placeholders.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadCommon(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const placeholders = (text: string): string[] => (text.match(/\{\w+\}/g) ?? []).sort();

const KEYS = ['sessionKill.outcomeUnknown', 'sessionKill.inProgress'];

describe('[#4160] kill outcome wording', () => {
  it.each(KEYS)('%s is in ja and en with the same placeholders', (key) => {
    const ja = resolve(loadCommon('ja'), key);
    const en = resolve(loadCommon('en'), key);
    expect(ja).toBeTypeOf('string');
    expect(en).toBeTypeOf('string');
    expect((ja as string).length).toBeGreaterThan(0);
    expect((en as string).length).toBeGreaterThan(0);
    expect(placeholders(ja as string)).toEqual(placeholders(en as string));
  });

  it('the End toast names the session, since it can land on another worktree', () => {
    for (const locale of ['ja', 'en']) {
      for (const key of ['sessionKill.outcomeUnknown', 'sessionKill.inProgress']) {
        expect(resolve(loadCommon(locale), key)).toContain('{label}');
      }
    }
  });
});
