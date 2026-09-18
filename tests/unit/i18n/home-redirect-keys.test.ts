/**
 * `/`（Issue #2643）が使う common の文言が両言語にあること。
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadCommon(locale: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, 'common.json'), 'utf-8'));
}

function resolve(dict: Record<string, unknown>, key: string): unknown {
  return key
    .split('.')
    .reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const KEYS = [
  'loadingPage',
  'sidebar.branchesLoadFailed',
  'sidebar.retryLoadBranches',
  'sidebar.noBranchesAvailable',
  'repositories.add',
];

describe('common keys used by the root route (Issue #2643)', () => {
  it.each(['en', 'ja'])('%s/common.json has every key as a non-empty string', (locale) => {
    const dict = loadCommon(locale);
    for (const key of KEYS) {
      const value = resolve(dict, key);
      expect(typeof value, `${locale}: ${key}`).toBe('string');
      expect((value as string).length, `${locale}: ${key}`).toBeGreaterThan(0);
    }
  });
});
