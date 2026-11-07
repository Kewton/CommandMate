/**
 * Migration v65 and the keys it holds (Issue #4132).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { rollbackMigrations, runMigrations } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import {
  getInstanceCreationKey,
  INSTANCE_CREATION_KEY_TTL_MS,
  recordInstanceCreationKey,
  settleInstanceCreationKey,
} from '@/lib/db/agent-roles-db';

describe('migration v65: agent_instance_creation_keys', () => {
  let db: Database.Database;
  const addWorktree = (id: string) =>
    db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run(id, id, `/tmp/${id}`, 1);
  const rows = () => (db.prepare('SELECT COUNT(*) AS c FROM agent_instance_creation_keys').get() as { c: number }).c;

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    addWorktree('wt');
  });
  afterEach(() => {
    vi.restoreAllMocks();
    db.close();
  });

  it('is followed by a worktree id rename, and goes with its worktree', () => {
    expect(getWorktreeChildTables(db)).toContainEqual({ table: 'agent_instance_creation_keys', column: 'worktree_id' });
    recordInstanceCreationKey(db, 'wt', 'key', 'claude-2', 'fp');
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt');
    expect(rows()).toBe(0);
  });

  it('the rollback removes the table and nothing else', () => {
    rollbackMigrations(db, 64);
    const table = db.prepare(`SELECT name FROM sqlite_master WHERE name = 'agent_instance_creation_keys'`).get();
    expect(table).toBeUndefined();
    expect(db.prepare(`SELECT name FROM sqlite_master WHERE name = 'agent_roles'`).get()).toBeDefined();
  });

  it('a key that made nothing is given up on, and stays so', () => {
    expect(settleInstanceCreationKey(db, 'wt', 'key')).toBeNull();
    expect(settleInstanceCreationKey(db, 'wt', 'key')).toBeNull();
    expect(getInstanceCreationKey(db, 'wt', 'key')).toEqual({ instanceId: null, requestFingerprint: null });
  });

  it('a key that made a row answers that row', () => {
    recordInstanceCreationKey(db, 'wt', 'key', 'claude-2', 'fp');
    expect(settleInstanceCreationKey(db, 'wt', 'key')).toBe('claude-2');
  });

  it('old keys go when a new one is written, and recent ones stay', () => {
    const now = 1800000000000;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    recordInstanceCreationKey(db, 'wt', 'old', 'a', 'fp');
    clock.mockReturnValue(now + INSTANCE_CREATION_KEY_TTL_MS);
    recordInstanceCreationKey(db, 'wt', 'recent', 'b', 'fp');
    expect(rows()).toBe(2);
    clock.mockReturnValue(now + INSTANCE_CREATION_KEY_TTL_MS + 1);
    settleInstanceCreationKey(db, 'wt', 'new');
    expect(getInstanceCreationKey(db, 'wt', 'old')).toBeNull();
    expect(getInstanceCreationKey(db, 'wt', 'recent')).not.toBeNull();
  });
});
