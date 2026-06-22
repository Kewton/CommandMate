/**
 * Unit tests for memo reorder i18n keys (Issue #944)
 *
 * Ensures the memoMoveUp / memoMoveDown labels exist in both the en and ja
 * `schedule` dictionaries (the namespace that hosts the analogous
 * agentInstanceMoveUp / agentInstanceMoveDown keys).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadSchedule(locale: string): Record<string, string> {
  const filePath = path.join(LOCALES_DIR, locale, 'schedule.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('memo reorder i18n keys (Issue #944)', () => {
  it('en/schedule.json contains memoMoveUp and memoMoveDown', () => {
    const en = loadSchedule('en');
    expect(en.memoMoveUp).toBeTruthy();
    expect(en.memoMoveDown).toBeTruthy();
  });

  it('ja/schedule.json contains memoMoveUp and memoMoveDown', () => {
    const ja = loadSchedule('ja');
    expect(ja.memoMoveUp).toBeTruthy();
    expect(ja.memoMoveDown).toBeTruthy();
  });

  it('keys exist in both locales (parity)', () => {
    const en = loadSchedule('en');
    const ja = loadSchedule('ja');
    for (const key of ['memoMoveUp', 'memoMoveDown']) {
      expect(en).toHaveProperty(key);
      expect(ja).toHaveProperty(key);
    }
  });
});
