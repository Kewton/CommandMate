/**
 * Unit tests for migration v41 (push_subscriptions table, Issue #1125).
 *
 * 1. Fresh DB end state — the migration chain creates push_subscriptions with
 *    the expected columns, the endpoint index, and the UNIQUE endpoint constraint.
 * 2. Rollback — down() drops the table and rewinds the recorded schema version.
 * 3. Idempotency — re-running the chain is a no-op and the table survives.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import {
  runMigrations,
  rollbackMigrations,
  getCurrentVersion,
  CURRENT_SCHEMA_VERSION,
} from '@/lib/db/db-migrations';

function tableNames(db: Database.Database): string[] {
  return (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as Array<{ name: string }>
  ).map((r) => r.name);
}

describe('migration v41: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('creates the push_subscriptions table', () => {
    expect(tableNames(db)).toContain('push_subscriptions');
  });

  it('has the expected columns', () => {
    const cols = (db.pragma('table_info(push_subscriptions)') as Array<{ name: string }>).map(
      (c) => c.name
    );
    expect(cols).toEqual(
      expect.arrayContaining([
        'id',
        'endpoint',
        'p256dh',
        'auth',
        'device_label',
        'enabled_prompt',
        'enabled_completion',
        'created_at',
        'updated_at',
      ])
    );
  });

  it('creates the endpoint index', () => {
    const indexes = (
      db
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='push_subscriptions'"
        )
        .all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(indexes).toContain('idx_push_subscriptions_endpoint');
  });

  it('enforces a UNIQUE constraint on endpoint', () => {
    const insert = db.prepare(
      `INSERT INTO push_subscriptions
        (id, endpoint, p256dh, auth, device_label, enabled_prompt, enabled_completion, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?, ?)`
    );
    insert.run('a', 'https://push.example/1', 'k', 'x', null, 1, 1);
    expect(() => insert.run('b', 'https://push.example/1', 'k', 'x', null, 1, 1)).toThrow();
  });
});

describe('migration v41: rollback', () => {
  it('down() drops the table and rewinds the version', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(tableNames(db)).toContain('push_subscriptions');

    rollbackMigrations(db, 40);

    expect(getCurrentVersion(db)).toBe(40);
    expect(tableNames(db)).not.toContain('push_subscriptions');
    db.close();
  });
});

describe('migration v41: idempotency via runner', () => {
  it('re-running runMigrations is a no-op and keeps the table', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    expect(tableNames(db)).toContain('push_subscriptions');
    db.close();
  });
});
