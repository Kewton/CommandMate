/**
 * Unit tests for migration v51 (task_events, Issue #1548).
 *
 * 1. Fresh DB end state — table, index, nullability.
 * 2. `to_status` really is nullable: a rejected transition is a row, and a NOT
 *    NULL here would silently turn every refusal into a crashed poller.
 * 3. Upgrade of an existing pre-v51 database, and rollback.
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

function indexNames(db: Database.Database, table: string): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name=?")
      .all(table) as Array<{ name: string }>
  ).map((r) => r.name);
}

function insertEvent(
  db: Database.Database,
  overrides: {
    taskId?: string | null;
    event?: string | null;
    fromStatus?: string | null;
    toStatus?: string | null;
    payloadJson?: string | null;
    createdAt?: number | null;
  } = {}
): void {
  db.prepare(
    `INSERT INTO task_events (task_id, event, from_status, to_status, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    overrides.taskId === undefined ? 'task-1' : overrides.taskId,
    overrides.event === undefined ? 'message_sent' : overrides.event,
    overrides.fromStatus === undefined ? 'pending' : overrides.fromStatus,
    overrides.toStatus === undefined ? 'running' : overrides.toStatus,
    overrides.payloadJson === undefined ? null : overrides.payloadJson,
    overrides.createdAt === undefined ? 1800000000000 : overrides.createdAt
  );
}

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
});

afterEach(() => {
  db.close();
});

describe('migration v51 — fresh database', () => {
  beforeEach(() => {
    runMigrations(db);
  });

  it('reaches CURRENT_SCHEMA_VERSION, which is at least 51', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(51);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('creates the task_events table and its lookup index', () => {
    expect(tableNames(db)).toContain('task_events');
    expect(indexNames(db, 'task_events')).toContain('idx_task_events_task');
  });

  it('accepts a rejected transition, which is a null to_status', () => {
    expect(() => insertEvent(db, { toStatus: null })).not.toThrow();
    expect(db.prepare('SELECT to_status FROM task_events').get()).toEqual({ to_status: null });
  });

  it('stores a payload verbatim', () => {
    insertEvent(db, { payloadJson: '{"runId":12}' });
    expect(db.prepare('SELECT payload_json FROM task_events').get()).toEqual({
      payload_json: '{"runId":12}',
    });
  });

  it('assigns ids in insertion order', () => {
    insertEvent(db, { event: 'message_sent' });
    insertEvent(db, { event: 'prompt_detected' });
    expect(
      db.prepare('SELECT event FROM task_events ORDER BY id ASC').all()
    ).toEqual([{ event: 'message_sent' }, { event: 'prompt_detected' }]);
  });

  it('requires the columns that make an event readable', () => {
    // Without these, a row records that "something happened" and nothing else.
    expect(() => insertEvent(db, { taskId: null })).toThrow(/NOT NULL constraint failed/);
    expect(() => insertEvent(db, { event: null })).toThrow(/NOT NULL constraint failed/);
    expect(() => insertEvent(db, { fromStatus: null })).toThrow(/NOT NULL constraint failed/);
    expect(() => insertEvent(db, { createdAt: null })).toThrow(/NOT NULL constraint failed/);
  });

  it('keeps events for a task that no longer exists', () => {
    // No FK to tasks on purpose: history that disappears with its subject
    // cannot be audited afterwards.
    expect(() => insertEvent(db, { taskId: 'never-existed' })).not.toThrow();
  });
});

describe('migration v51 — upgrade and rollback', () => {
  it('adds task_events to a database that stopped at v50', () => {
    runMigrations(db);
    rollbackMigrations(db, 50);
    expect(tableNames(db)).not.toContain('task_events');
    expect(getCurrentVersion(db)).toBe(50);

    runMigrations(db);
    expect(tableNames(db)).toContain('task_events');
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('leaves tasks intact when task_events is rolled back', () => {
    runMigrations(db);
    rollbackMigrations(db, 50);
    expect(tableNames(db)).toContain('tasks');
  });
});
