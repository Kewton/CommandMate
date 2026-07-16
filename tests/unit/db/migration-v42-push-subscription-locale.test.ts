/**
 * Unit tests for migration v42 (push_subscriptions.locale, Issue #1308).
 *
 * The acceptance criterion is that the migration runs in *both* directions, so
 * rollback is asserted here rather than accepted as a no-op the way v35/v40 do.
 *
 * @vitest-environment node
 */

import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

function columns(db: Database.Database): string[] {
  return (db.pragma('table_info(push_subscriptions)') as Array<{ name: string }>).map((c) => c.name);
}

describe('migration v42: up', () => {
  it('adds the locale column', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(columns(db)).toContain('locale');
    db.close();
  });

  it('leaves locale nullable with no backfill, so pre-v42 rows read back NULL', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO push_subscriptions
         (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, created_at, updated_at)
       VALUES ('a', 'https://push.example/1', 'k', 'x', NULL, 1, 1, 0, 0)`
    ).run();
    const row = db
      .prepare('SELECT locale FROM push_subscriptions WHERE id = ?')
      .get('a') as { locale: string | null };
    expect(row.locale).toBeNull();
    db.close();
  });

  it('reaches the current schema version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(42);
    db.close();
  });
});

describe('migration v42: down', () => {
  it('drops the locale column and rewinds to 41, keeping the table and its rows', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    db.prepare(
      `INSERT INTO push_subscriptions
         (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, locale, created_at, updated_at)
       VALUES ('a', 'https://push.example/1', 'k', 'x', NULL, 1, 1, 'ja', 0, 0)`
    ).run();

    rollbackMigrations(db, 41);

    expect(getCurrentVersion(db)).toBe(41);
    expect(columns(db)).not.toContain('locale');
    // Rolling back a column must not take the subscription with it.
    expect(columns(db)).toContain('endpoint');
    expect(
      (db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get() as { n: number }).n
    ).toBe(1);
    db.close();
  });

  it('survives a full down/up round trip', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    rollbackMigrations(db, 41);
    expect(columns(db)).not.toContain('locale');

    runMigrations(db);

    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(columns(db)).toContain('locale');
    db.close();
  });
});
