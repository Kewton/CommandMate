/**
 * The one-off cleanup for wrapped duplicate rows (Issue #3102).
 *
 * @vitest-environment node
 */

import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  applyDedupePlan,
  findCounterpart,
  loadUserRows,
  parseArgs,
  planDedupe,
  run,
  unwrapPastedContent,
  type DedupeRow,
} from '../../../../scripts/history/dedupe-pasted-user-rows';

const BASE = Date.parse('2026-10-03T00:00:00.000Z');
const BODY = '/orchestrate 3099\n\n説明';
const wrap = (body: string) => `\n\n<pasted_content id="6b21">\n${body}\n</pasted_content id="6b21">`;

let dir: string;
let dbPath: string;

function insert(
  db: Database.Database,
  id: string,
  content: string,
  at: number,
  requestId: string | null,
  messageType = 'normal',
  worktree = 'wt'
): void {
  db.prepare(
    `INSERT INTO chat_messages (id, worktree_id, role, content, timestamp, request_id, message_type, cli_tool_id, instance_id)
     VALUES (?, ?, 'user', ?, ?, ?, ?, 'claude', 'claude')`
  ).run(id, worktree, content, at, requestId, messageType);
}

function seed(db: Database.Database): void {
  db.prepare(
    `INSERT INTO worktrees (id, name, path, repository_path, repository_name) VALUES ('wt', 'wt', '/p', '/r', 'R')`
  ).run();
  // pattern 1: /send counterpart
  insert(db, 'send-1', BODY, BASE, null);
  insert(db, 'wrapped-1', wrap(BODY), BASE + 1000, 'claude-prompt:u1');
  // pattern 2: relay counterpart
  insert(db, 'relay-2', 'relayed body', BASE + 600_000, 'relay:L1', 'relay');
  insert(db, 'wrapped-2', wrap('relayed body'), BASE + 601_000, 'claude-prompt:u2');
  // pattern 3: no counterpart
  insert(db, 'wrapped-3', wrap('lonely'), BASE + 1_200_000, 'claude-prompt:u3');
}

function snapshot(db: Database.Database) {
  return db.prepare('SELECT id, request_id FROM chat_messages ORDER BY id').all();
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'dedupe-3102-'));
  dbPath = join(dir, 'test.db');
  const db = new Database(dbPath);
  runMigrations(db);
  seed(db);
  db.close();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('pure helpers', () => {
  it('unwraps only a wrapped body', () => {
    expect(unwrapPastedContent(wrap(BODY))?.trim()).toBe(BODY);
    expect(unwrapPastedContent(BODY)).toBeNull();
  });

  it('plans one action per pattern', () => {
    const db = new Database(dbPath);
    const plan = planDedupe(loadUserRows(db));
    db.close();
    expect(plan.actions).toEqual(
      expect.arrayContaining([
        { kind: 'move-key', wrappedId: 'wrapped-1', targetId: 'send-1', requestId: 'claude-prompt:u1' },
        { kind: 'delete-wrapped', wrappedId: 'wrapped-2', relayId: 'relay-2' },
        { kind: 'leave', wrappedId: 'wrapped-3' },
      ])
    );
    expect([plan.moveKey, plan.deleteWrapped, plan.left]).toEqual([1, 1, 1]);
  });

  it('does not match a row of another worktree or outside two minutes', () => {
    const base: DedupeRow = {
      id: 'w', worktree_id: 'wt', cli_tool_id: 'claude', instance_id: 'claude',
      content: wrap(BODY), timestamp: BASE, request_id: 'claude-prompt:u', message_type: 'normal',
    };
    const other: DedupeRow = { ...base, id: 's', content: BODY, request_id: null };
    expect(findCounterpart(base, [other])?.id).toBe('s');
    expect(findCounterpart(base, [{ ...other, worktree_id: 'x' }])).toBeNull();
    expect(findCounterpart(base, [{ ...other, timestamp: BASE + 121_000 }])).toBeNull();
  });
});

describe('the script', () => {
  it('defaults to a dry run and changes nothing', () => {
    expect(parseArgs(['--db', dbPath]).apply).toBe(false);
    const db = new Database(dbPath);
    const before = snapshot(db);
    db.close();

    run(['--db', dbPath], () => undefined);

    const after = new Database(dbPath);
    expect(snapshot(after)).toEqual(before);
    after.close();
  });

  it('--apply moves the key, keeps the relay row, and leaves the lonely row', () => {
    run(['--db', dbPath, '--apply'], () => undefined);

    const db = new Database(dbPath);
    const rows = new Map((snapshot(db) as { id: string; request_id: string | null }[]).map((r) => [r.id, r.request_id]));
    db.close();
    expect(rows.has('wrapped-1')).toBe(false);
    expect(rows.get('send-1')).toBe('claude-prompt:u1');
    expect(rows.has('wrapped-2')).toBe(false);
    expect(rows.get('relay-2')).toBe('relay:L1');
    expect(rows.get('wrapped-3')).toBe('claude-prompt:u3');
  });

  it('rolls back when a counterpart was keyed meanwhile', () => {
    const db = new Database(dbPath);
    const plan = planDedupe(loadUserRows(db));
    db.prepare("UPDATE chat_messages SET request_id = 'claimed' WHERE id = 'send-1'").run();
    const before = snapshot(db);
    expect(() => applyDedupePlan(db, plan)).toThrow();
    expect(snapshot(db)).toEqual(before);
    db.close();
  });
});
