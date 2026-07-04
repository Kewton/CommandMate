/**
 * Unit tests for the branch-scoped ToDo sub-tab i18n key (Issue #1015).
 *
 * The mobile Tools `ToDo` sub-tab label resolves via `t('todoTab')` in the
 * `schedule` namespace (NotesAndLogsPane). `src/i18n.ts` has no onError /
 * getMessageFallback, so a missing ja key would surface the raw key string in
 * production and go undetected in CI ([S3-003]). This test enforces en/ja
 * parity for `todoTab`, mirroring the memoMoveUp/memoMoveDown parity test.
 */

import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const LOCALES_DIR = path.resolve(__dirname, '../../../locales');

function loadSchedule(locale: string): Record<string, string> {
  const filePath = path.join(LOCALES_DIR, locale, 'schedule.json');
  return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
}

describe('ToDo sub-tab i18n key (Issue #1015)', () => {
  it('en/schedule.json contains todoTab', () => {
    const en = loadSchedule('en');
    expect(en.todoTab).toBeTruthy();
  });

  it('ja/schedule.json contains todoTab', () => {
    const ja = loadSchedule('ja');
    expect(ja.todoTab).toBeTruthy();
  });

  it('todoTab exists in both locales (parity)', () => {
    const en = loadSchedule('en');
    const ja = loadSchedule('ja');
    expect(en).toHaveProperty('todoTab');
    expect(ja).toHaveProperty('todoTab');
  });
});
