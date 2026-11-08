/**
 * Migration v68: the session-brief ledger (Issue #4274, design §3.2). v68 lands
 * before #4222's v67 (PM decision): a database at v66 reaches v68 with no v67.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, rollbackMigrations, runMigrations } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import {
  BOUNDARY_RETAINED_ROWS,
  claimBoundary,
  getCurrentBoundary,
  isSameInstanceLifetime,
  listRetainedBoundaries,
  openBoundary,
  settleBoundaryClaim,
} from '@/lib/db/session-brief-db';

const LIFETIME = { incarnation: null, incarnationToolId: null, rosterCreatedAt: null };

describe('migration v68: session_brief_boundaries', () => {
  let db: Database.Database;
  const open = (instanceId = 'claude', at = 1) =>
    openBoundary(db, { worktreeId: 'wt', instanceId, cliToolId: 'claude', lifetime: LIFETIME, kind: 'launch', evidence: 'launch', openedAt: at });

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run('wt', 'wt', '/tmp/wt', 1);
  });
  afterEach(() => db.close());

  it('lands on the current version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(68);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is a worktree child: it goes with its worktree', () => {
    expect(getWorktreeChildTables(db)).toContainEqual({ table: 'session_brief_boundaries', column: 'worktree_id' });
    open();
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt');
    expect(db.prepare('SELECT COUNT(*) AS c FROM session_brief_boundaries').get()).toEqual({ c: 0 });
  });

  it('refuses a state, kind or evidence it does not have', () => {
    open();
    expect(() => db.prepare("UPDATE session_brief_boundaries SET state = 'read'").run()).toThrow();
    expect(() => db.prepare("UPDATE session_brief_boundaries SET kind = 'compact'").run()).toThrow();
    expect(() => db.prepare("UPDATE session_brief_boundaries SET evidence = 'screen'").run()).toThrow();
  });

  it('a new row supersedes the pending one, keeps a claimed one, and keeps 20 rows per instance', () => {
    const first = open();
    const second = open();
    expect(listRetainedBoundaries(db, 'wt', 'claude').map((row) => row.state)).toEqual(['pending', 'superseded']);
    expect(claimBoundary(db, second.id, 't', null)).toBe(true);
    open();
    expect(listRetainedBoundaries(db, 'wt', 'claude').map((row) => row.state)).toEqual(['pending', 'claimed', 'superseded']);
    for (let i = 0; i < BOUNDARY_RETAINED_ROWS + 5; i++) open();
    expect(listRetainedBoundaries(db, 'wt', 'claude')).toHaveLength(BOUNDARY_RETAINED_ROWS);
    expect(listRetainedBoundaries(db, 'wt', 'claude').some((row) => row.id === first.id)).toBe(false);
    // (control) another instance keeps its own rows.
    open('claude-2');
    expect(getCurrentBoundary(db, 'wt', 'claude-2')?.seq).toBe(1);
  });

  it('only the claim’s own token settles it; not_sent puts it back to pending', () => {
    const row = open();
    claimBoundary(db, row.id, 'mine', null);
    expect(settleBoundaryClaim(db, row.id, 'other', 'sent', null, 2)).toBe(false);
    expect(settleBoundaryClaim(db, row.id, 'mine', 'not_sent', null, 2)).toBe(true);
    expect(getCurrentBoundary(db, 'wt', 'claude')).toMatchObject({ state: 'pending', attempts: 1, claimToken: null, lastOutcome: 'not_sent' });
    expect(claimBoundary(db, row.id, 'again', 'some-incarnation')).toBe(false);
  });

  it('the lifetime rule (design §3.7)', () => {
    const now = (incarnation: string | null, rosterCreatedAt: number | null, tool = 'claude') => ({
      incarnation,
      incarnationToolId: incarnation ? tool : null,
      rosterCreatedAt,
    });
    expect(isSameInstanceLifetime({ incarnation: 'a', rosterCreatedAt: 1 }, now('a', 2), 'claude')).toBe(true);
    expect(isSameInstanceLifetime({ incarnation: 'a', rosterCreatedAt: 1 }, now('b', 1), 'claude')).toBe(false);
    expect(isSameInstanceLifetime({ incarnation: 'a', rosterCreatedAt: 1 }, now(null, 1), 'claude')).toBe(false);
    expect(isSameInstanceLifetime({ incarnation: null, rosterCreatedAt: 1 }, now('a', 1), 'claude')).toBe(true);
    expect(isSameInstanceLifetime({ incarnation: null, rosterCreatedAt: 1 }, now('a', 2), 'claude')).toBe(false);
    expect(isSameInstanceLifetime({ incarnation: null, rosterCreatedAt: null }, now('a', null, 'codex'), 'claude')).toBe(false);
    expect(isSameInstanceLifetime({ incarnation: null, rosterCreatedAt: null }, now(null, null), 'claude')).toBe(true);
  });

  it('the rollback removes the table and nothing else', () => {
    rollbackMigrations(db, 66);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'session_brief_boundaries'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mem_items'").get()).toBeDefined();
  });
});
