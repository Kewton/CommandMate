/**
 * The "still waiting" reminder setting (Issue #1790).
 *
 * The reads here are made from a background timer with nothing to report a
 * failure to, so the property under test is not "it round-trips" but "it always
 * answers": a missing row, a truncated JSON blob, a hostile threshold and a
 * closed database must all resolve to the documented defaults rather than throw
 * a minute after the user walked away.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';

let db: Database.Database;
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

import {
  DEFAULT_ESCALATION_SETTINGS,
  ESCALATION_SETTINGS_KEY,
  MAX_ESCALATION_THRESHOLD_MINUTES,
  getPushEscalationSettings,
  normalizeEscalationSettings,
  setPushEscalationSettings,
} from '@/lib/push/escalation-settings';

function writeRaw(value: string): void {
  const now = Date.now();
  db.prepare(
    `INSERT INTO app_settings (key, value, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`
  ).run(ESCALATION_SETTINGS_KEY, value, now, now);
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('defaults', () => {
  it('is on at ten minutes for an install that never opened settings', () => {
    expect(DEFAULT_ESCALATION_SETTINGS).toEqual({ enabled: true, thresholdMinutes: 10 });
    expect(getPushEscalationSettings()).toEqual(DEFAULT_ESCALATION_SETTINGS);
  });

  it('answers with the defaults rather than throwing when the database cannot', () => {
    db.close();
    expect(() => getPushEscalationSettings()).not.toThrow();
    expect(getPushEscalationSettings()).toEqual(DEFAULT_ESCALATION_SETTINGS);
    // Reopened so afterEach's close does not fail on an already-closed handle.
    db = new Database(':memory:');
    runMigrations(db);
  });
});

describe('round trip', () => {
  it('persists both fields', () => {
    expect(setPushEscalationSettings({ enabled: false, thresholdMinutes: 30 })).toEqual({
      enabled: false,
      thresholdMinutes: 30,
    });
    expect(getPushEscalationSettings()).toEqual({ enabled: false, thresholdMinutes: 30 });
  });

  it('overwrites rather than accumulating rows', () => {
    setPushEscalationSettings({ enabled: true, thresholdMinutes: 5 });
    setPushEscalationSettings({ enabled: true, thresholdMinutes: 60 });

    const rows = db
      .prepare('SELECT COUNT(*) as n FROM app_settings WHERE key = ?')
      .get(ESCALATION_SETTINGS_KEY) as { n: number };
    expect(rows.n).toBe(1);
    expect(getPushEscalationSettings().thresholdMinutes).toBe(60);
  });
});

describe('normalization', () => {
  it('fills each field independently, so one bad value cannot flip the other', () => {
    // A threshold of zero would make every wait escalate instantly; the user's
    // explicit `enabled: false` must survive being sent alongside it.
    expect(normalizeEscalationSettings({ enabled: false, thresholdMinutes: 0 })).toEqual({
      enabled: false,
      thresholdMinutes: DEFAULT_ESCALATION_SETTINGS.thresholdMinutes,
    });
    expect(normalizeEscalationSettings({ thresholdMinutes: 45 })).toEqual({
      enabled: true,
      thresholdMinutes: 45,
    });
  });

  it.each([
    [{ thresholdMinutes: -5 }],
    [{ thresholdMinutes: MAX_ESCALATION_THRESHOLD_MINUTES + 1 }],
    [{ thresholdMinutes: Number.NaN }],
    [{ thresholdMinutes: Number.POSITIVE_INFINITY }],
    [{ thresholdMinutes: '10' }],
    [null],
    ['nonsense'],
  ])('falls back to the default threshold for %j', (value) => {
    expect(normalizeEscalationSettings(value).thresholdMinutes).toBe(
      DEFAULT_ESCALATION_SETTINGS.thresholdMinutes
    );
  });

  it('rounds a fractional threshold instead of rejecting it', () => {
    expect(normalizeEscalationSettings({ thresholdMinutes: 12.4 }).thresholdMinutes).toBe(12);
  });

  it('survives a stored value that is not JSON at all', () => {
    writeRaw('{{ truncated');
    expect(getPushEscalationSettings()).toEqual(DEFAULT_ESCALATION_SETTINGS);
  });

  it('survives a stored value of the wrong shape', () => {
    writeRaw(JSON.stringify(['enabled']));
    expect(getPushEscalationSettings()).toEqual(DEFAULT_ESCALATION_SETTINGS);
  });
});
