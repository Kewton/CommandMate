/**
 * Unit tests for migration v40 (timer_messages.error, Issue #1107).
 *
 * Three angles:
 *  1. Fresh DB end state — the full migration chain adds a nullable `error`
 *     column to timer_messages.
 *  2. Harmless migration — applying v40.up() over a v35-shaped table leaves
 *     existing rows with error = NULL (no data loss).
 *  3. Idempotency — re-running the migration chain is a no-op (runner-level).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION, getCurrentVersion } from '@/lib/db/db-migrations';
import { v40_migrations } from '@/lib/db/migrations/v40-timer-error';

interface ColumnInfo { name: string; notnull: number; dflt_value: string | null }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

describe('migration v40: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('brings the schema to v40', () => {
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(40);
  });

  it('adds a nullable error column (TEXT, not NOT NULL)', () => {
    const errorCol = columns(db, 'timer_messages').find((c) => c.name === 'error');
    expect(errorCol).toBeDefined();
    expect(errorCol!.notnull).toBe(0);
  });

  it('keeps the existing timer columns alongside error', () => {
    const names = columns(db, 'timer_messages').map((c) => c.name);
    expect(names).toContain('message');
    expect(names).toContain('status');
    expect(names).toContain('instance_id');
    expect(names).toContain('error');
  });
});

describe('migration v40: harmless migration over existing rows', () => {
  let db: Database.Database;

  beforeEach(() => {
    // Reconstruct a v35-shaped table (no error column) to exercise up().
    db = new Database(':memory:');
    db.exec(`
      CREATE TABLE timer_messages (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        cli_tool_id TEXT NOT NULL,
        instance_id TEXT,
        message TEXT NOT NULL,
        delay_ms INTEGER NOT NULL,
        scheduled_send_time INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        created_at INTEGER NOT NULL,
        sent_at INTEGER
      );
    `);
    db.prepare(`
      INSERT INTO timer_messages (id, worktree_id, cli_tool_id, instance_id, message, delay_ms, scheduled_send_time, status, created_at, sent_at)
      VALUES ('existing', 'wt-1', 'claude', 'claude', 'legacy', 300000, 9999999999999, 'failed', 1, NULL)
    `).run();
  });

  afterEach(() => {
    db.close();
  });

  it('backfills existing rows with error = NULL (no data loss)', () => {
    v40_migrations[0].up(db);

    const row = db
      .prepare('SELECT id, message, status, error FROM timer_messages WHERE id = ?')
      .get('existing') as { id: string; message: string; status: string; error: string | null };

    expect(row.message).toBe('legacy');
    expect(row.status).toBe('failed');
    expect(row.error).toBeNull();
  });
});

describe('migration v40: idempotency via runner', () => {
  it('re-running runMigrations is a no-op', () => {
    const db = new Database(':memory:');
    runMigrations(db);
    expect(() => runMigrations(db)).not.toThrow();
    const names = columns(db, 'timer_messages').map((c) => c.name);
    expect(names).toContain('error');
    db.close();
  });
});
