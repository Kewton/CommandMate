/**
 * Unit tests for the mobile Skills sub-tab i18n key (Issue #1442).
 *
 * The mobile Tools `Skills` sub-tab label resolves via `t('skillsTab')` in the
 * `schedule` namespace (NotesAndLogsPane). `src/i18n.ts` has no onError /
 * getMessageFallback, so a missing ja key would surface the raw key string in
 * production and go undetected in CI. This test enforces en/ja parity for
 * `skillsTab`, mirroring the todoTab parity test (Issue #1015).
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadSchedule(locale: string): Record<string, string> {
  const filePath = path.join(LOCALES_DIR, locale, 'schedule.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('Skills sub-tab i18n key (Issue #1442)', () => {
  it('en/schedule.json contains skillsTab', () => {
    const en = loadSchedule('en');
    expect(en.skillsTab).toBeTruthy();
  });

  it('ja/schedule.json contains skillsTab', () => {
    const ja = loadSchedule('ja');
    expect(ja.skillsTab).toBeTruthy();
  });

  it('skillsTab exists in both locales (parity)', () => {
    const en = loadSchedule('en');
    const ja = loadSchedule('ja');
    expect(en).toHaveProperty('skillsTab');
    expect(ja).toHaveProperty('skillsTab');
  });
});
