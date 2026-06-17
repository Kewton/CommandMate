/**
 * Unit tests for migration v33 (agent instances, Issue #868).
 *
 * Two angles:
 *  1. Fresh DB end state — running the full migration chain yields the
 *     instance-scoped schema (session_states PK, chat_messages.instance_id,
 *     agent_instances table).
 *  2. Legacy backfill — running v33.up() over a pre-v33 schema populated with
 *     legacy rows migrates every row to instance_id = cli_tool_id (the primary
 *     instance anchor) and backfills agent_instances from selected_agents.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { v33_migrations } from '@/lib/db/migrations/v33-agent-instances';

interface ColumnInfo { name: string; pk: number }

function columns(db: Database.Database, table: string): ColumnInfo[] {
  return db.pragma(`table_info(${table})`) as ColumnInfo[];
}

function pkColumns(db: Database.Database, table: string): string[] {
  return columns(db, table)
    .filter(c => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map(c => c.name);
}

function tableExists(db: Database.Database, table: string): boolean {
  const row = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name = ?`
  ).get(table);
  return !!row;
}

describe('migration v33: fresh DB end state', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  it('rebuilds session_states with primary key (worktree_id, instance_id)', () => {
    const cols = columns(db, 'session_states').map(c => c.name);
    expect(cols).toContain('instance_id');
    expect(cols).toContain('cli_tool_id');
    expect(pkColumns(db, 'session_states')).toEqual(['worktree_id', 'instance_id']);
  });

  it('adds an instance_id column to chat_messages', () => {
    expect(columns(db, 'chat_messages').map(c => c.name)).toContain('instance_id');
  });

  it('creates the agent_instances table with PK (worktree_id, instance_id)', () => {
    expect(tableExists(db, 'agent_instances')).toBe(true);
    expect(pkColumns(db, 'agent_instances')).toEqual(['worktree_id', 'instance_id']);
  });
});

describe('migration v33: legacy backfill (up() in isolation)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    // Minimal pre-v33 schema with the columns v33.up() reads/rebuilds.
    db.exec(`
      CREATE TABLE worktrees (
        id TEXT PRIMARY KEY,
        name TEXT,
        path TEXT,
        cli_tool_id TEXT DEFAULT 'claude',
        selected_agents TEXT,
        updated_at INTEGER
      );
      CREATE TABLE session_states (
        worktree_id TEXT NOT NULL,
        cli_tool_id TEXT NOT NULL DEFAULT 'claude',
        last_captured_line INTEGER DEFAULT 0,
        in_progress_message_id TEXT DEFAULT NULL,
        PRIMARY KEY (worktree_id, cli_tool_id)
      );
      CREATE TABLE chat_messages (
        id TEXT PRIMARY KEY,
        worktree_id TEXT NOT NULL,
        cli_tool_id TEXT DEFAULT 'claude',
        role TEXT,
        content TEXT,
        timestamp INTEGER
      );
    `);
  });

  afterEach(() => {
    db.close();
  });

  function runV33(): void {
    v33_migrations[0].up(db);
  }

  it('migrates legacy session_states rows to instance_id = cli_tool_id', () => {
    db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, selected_agents, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('wt-a', 'A', '/tmp/a', 'codex', null, 1700000000000);
    db.prepare(`INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line) VALUES (?,?,?)`)
      .run('wt-a', 'codex', 42);

    runV33();

    const row = db.prepare(
      `SELECT instance_id, cli_tool_id, last_captured_line FROM session_states WHERE worktree_id = ?`
    ).get('wt-a') as { instance_id: string; cli_tool_id: string; last_captured_line: number };
    expect(row.instance_id).toBe('codex');
    expect(row.cli_tool_id).toBe('codex');
    expect(row.last_captured_line).toBe(42);
  });

  it('backfills chat_messages.instance_id from cli_tool_id', () => {
    db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, updated_at) VALUES (?,?,?,?,?)`)
      .run('wt-b', 'B', '/tmp/b', 'claude', 1700000000000);
    db.prepare(`INSERT INTO chat_messages (id, worktree_id, cli_tool_id, role, content, timestamp) VALUES (?,?,?,?,?,?)`)
      .run('m1', 'wt-b', 'gemini', 'user', 'hi', 1700000000001);

    runV33();

    const row = db.prepare(`SELECT instance_id FROM chat_messages WHERE id = ?`).get('m1') as { instance_id: string };
    expect(row.instance_id).toBe('gemini');
  });

  it('backfills one primary instance per selected_agents tool', () => {
    db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, selected_agents, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('wt-c', 'C', '/tmp/c', 'claude', JSON.stringify(['claude', 'codex']), 1700000000000);

    runV33();

    const rows = db.prepare(
      `SELECT instance_id, cli_tool_id, sort_order FROM agent_instances WHERE worktree_id = ? ORDER BY sort_order`
    ).all('wt-c') as Array<{ instance_id: string; cli_tool_id: string; sort_order: number }>;

    expect(rows).toHaveLength(2);
    // Primary-instance anchor: instance_id === cli_tool_id.
    expect(rows[0]).toMatchObject({ instance_id: 'claude', cli_tool_id: 'claude', sort_order: 0 });
    expect(rows[1]).toMatchObject({ instance_id: 'codex', cli_tool_id: 'codex', sort_order: 1 });
  });

  it('falls back to the single cli_tool_id when selected_agents is empty/missing', () => {
    db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, selected_agents, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('wt-d', 'D', '/tmp/d', 'codex', null, 1700000000000);

    runV33();

    const rows = db.prepare(
      `SELECT instance_id, cli_tool_id FROM agent_instances WHERE worktree_id = ?`
    ).all('wt-d') as Array<{ instance_id: string; cli_tool_id: string }>;
    expect(rows).toEqual([{ instance_id: 'codex', cli_tool_id: 'codex' }]);
  });

  it('skips orphaned session_states rows so the FK rebuild does not abort (regression)', () => {
    // Production enforces FK; long-lived DBs accumulate session_states rows
    // whose worktree was deleted. The rebuilt table's FK would reject them and
    // abort the whole migration ("FOREIGN KEY constraint failed").
    db.pragma('foreign_keys = ON');
    db.prepare(`INSERT INTO worktrees (id, name, path, cli_tool_id, selected_agents, updated_at) VALUES (?,?,?,?,?,?)`)
      .run('wt-live', 'Live', '/tmp/live', 'claude', null, 1700000000000);
    // Valid row + orphan row (worktree 'wt-gone' does not exist).
    db.prepare(`INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line) VALUES (?,?,?)`)
      .run('wt-live', 'claude', 7);
    db.prepare(`INSERT INTO session_states (worktree_id, cli_tool_id, last_captured_line) VALUES (?,?,?)`)
      .run('wt-gone', 'claude', 99);

    expect(() => runV33()).not.toThrow();

    // Migration completed: agent_instances exists, valid row kept, orphan dropped.
    expect(tableExists(db, 'agent_instances')).toBe(true);
    const live = db.prepare(`SELECT last_captured_line FROM session_states WHERE worktree_id = ?`)
      .get('wt-live') as { last_captured_line: number } | undefined;
    expect(live?.last_captured_line).toBe(7);
    const orphan = db.prepare(`SELECT 1 FROM session_states WHERE worktree_id = ?`).get('wt-gone');
    expect(orphan).toBeUndefined();
  });
});
