/**
 * Unit-level i18n parity test for the command palette namespace (Issue #1053).
 *
 * `src/i18n.ts` has no onError / getMessageFallback, so a missing key in one
 * locale would surface the raw key string in production and go undetected.
 * This test enforces full deep-key parity for the `commandPalette` namespace
 * across en / ja, mirroring the existing toc-keys / todo-tab-keys parity tests.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadCommandPalette(locale: string): Record<string, unknown> {
  const filePath = path.join(LOCALES_DIR, locale, 'commandPalette.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

/** Collect all dot-joined leaf key paths from a nested object. */
function leafKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([key, value]) => {
    const full = prefix ? `${prefix}.${key}` : key;
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      return leafKeys(value as Record<string, unknown>, full);
    }
    return [full];
  });
}

describe('command palette i18n keys (Issue #1053)', () => {
  it.each(['en', 'ja'])('%s/commandPalette.json has non-empty values for every leaf', (locale) => {
    const dict = loadCommandPalette(locale);
    const keys = leafKeys(dict);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      const value = key
        .split('.')
        .reduce<unknown>((acc, part) => (acc as Record<string, unknown>)[part], dict);
      expect(value, `${locale}: ${key}`).toBeTruthy();
    }
  });

  it('en and ja expose the identical set of keys (parity)', () => {
    const en = leafKeys(loadCommandPalette('en')).sort();
    const ja = leafKeys(loadCommandPalette('ja')).sort();
    expect(en).toEqual(ja);
  });

  it('includes the core navigation / group / action keys', () => {
    const en = loadCommandPalette('en');
    const keys = leafKeys(en);
    for (const expected of [
      'placeholder',
      'empty',
      'groups.navigation',
      'groups.worktrees',
      'groups.actions',
      'nav.sessions',
      'actions.toLight',
      'actions.toDark',
      'mobileTrigger',
    ]) {
      expect(keys).toContain(expected);
    }
  });
});
