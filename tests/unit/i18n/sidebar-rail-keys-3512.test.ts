/**
 * Keys added by Issue #3512 (icon rail, Mod+B, palette "New task") exist with
 * non-empty, translated values in en and ja.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function read(locale: string, namespace: string, keyPath: string): unknown {
  const dict = JSON.parse(fs.readFileSync(path.join(LOCALES_DIR, locale, `${namespace}.json`), 'utf-8'));
  return keyPath.split('.').reduce<unknown>((acc, part) => (acc as Record<string, unknown> | undefined)?.[part], dict);
}

const KEYS: Array<[namespace: string, keyPath: string]> = [
  ['common', 'sidebar.railLabel'],
  ['commandPalette', 'actions.newTask'],
  ['keyboardShortcuts', 'shortcuts.toggleSidebar'],
];

describe('Issue #3512 i18n keys', () => {
  it.each(KEYS)('%s.%s is a non-empty string in en and ja, and translated', (namespace, keyPath) => {
    const en = read('en', namespace, keyPath);
    const ja = read('ja', namespace, keyPath);
    expect(typeof en).toBe('string');
    expect(typeof ja).toBe('string');
    expect((en as string).length).toBeGreaterThan(0);
    expect((ja as string).length).toBeGreaterThan(0);
    expect(ja).not.toBe(en);
  });
});
