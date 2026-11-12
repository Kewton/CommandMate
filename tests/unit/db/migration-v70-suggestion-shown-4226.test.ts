/**
 * Migration v70: the record of the mem prompts shown (Issue #4226, design §4.2). It lands
 * after #4225's v69; a database at v68 reaches v70 through v69.
 *
 * @vitest-environment node
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { CURRENT_SCHEMA_VERSION, getCurrentVersion, rollbackMigrations, runMigrations } from '@/lib/db/db-migrations';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import { renameWorktreeIdPreservingChildren } from '@/lib/db/migrations/worktree-id-rename';
import { countShown, readShown, settleShown } from '@/lib/db/suggestion-shown-db';

describe('migration v70: suggestion_shown', () => {
  let db: Database.Database;
  const put = (code: string, scope = 's1', instanceId = 'claude', worktreeId = 'wt') =>
    settleShown(db, {
      worktreeId,
      instanceId,
      scopeHash: scope,
      write: [{ code, instanceIncarnation: null, boundaryId: null, fingerprint: 'f', shownAt: 1 }],
      clear: [],
      rosterInstanceIds: [instanceId],
      knownCodes: [code, 'now_missing', 'now_stale'],
      liveScopeHashes: new Set(['s1', 's2']),
    });

  beforeEach(() => {
    db = new Database(':memory:');
    db.pragma('foreign_keys = ON');
    runMigrations(db);
    db.prepare('INSERT INTO worktrees (id, name, path, updated_at) VALUES (?, ?, ?, ?)').run('wt', 'wt', '/tmp/wt', 1);
  });
  afterEach(() => db.close());

  it('lands on the current version (70)', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(70);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });

  it('is keyed by (worktree, instance, code, scope): one row per scope, a second put replaces the value', () => {
    put('now_missing', 's1');
    put('now_missing', 's2');
    put('now_missing', 's1');
    expect(countShown(db, 'wt')).toBe(2);
    expect([...readShown(db, 'wt', 'claude', 's1').keys()]).toEqual(['now_missing']);
    expect(readShown(db, 'wt', 'claude', 's3').size).toBe(0);
  });

  it('is a worktree child: a rename moves its rows, a delete takes them', () => {
    expect(getWorktreeChildTables(db)).toContainEqual({ table: 'suggestion_shown', column: 'worktree_id' });
    put('now_missing');
    db.transaction(() => renameWorktreeIdPreservingChildren(db, 'wt', 'wt-new', 2))();
    expect(countShown(db, 'wt')).toBe(0);
    expect(countShown(db, 'wt-new')).toBe(1);
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('wt-new');
    expect(db.prepare('SELECT COUNT(*) AS c FROM suggestion_shown').get()).toEqual({ c: 0 });
  });

  it('holds no text: ids, a code, hashes and a time only', () => {
    const columns = (db.prepare("PRAGMA table_info('suggestion_shown')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(columns).toEqual(['worktree_id', 'instance_id', 'code', 'instance_incarnation', 'boundary_id', 'scope_hash', 'fingerprint', 'shown_at']);
  });

  it('a scope outside the live set and a code outside the table go in the same transaction as a write', () => {
    put('now_missing', 's1');
    put('gone_code', 's1');
    settleShown(db, {
      worktreeId: 'wt',
      instanceId: 'claude',
      scopeHash: 's2',
      write: [],
      clear: [],
      rosterInstanceIds: ['claude'],
      knownCodes: ['now_missing'],
      liveScopeHashes: new Set(['s2']),
    });
    expect(countShown(db, 'wt')).toBe(0);
  });

  it('rolls back to v69 without touching mem_items or v69’s tables', () => {
    rollbackMigrations(db, 69);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'suggestion_shown'").get()).toBeUndefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mem_items'").get()).toBeDefined();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name = 'mem_promote_operations'").get()).toBeDefined();
    runMigrations(db);
    expect(getCurrentVersion(db)).toBe(CURRENT_SCHEMA_VERSION);
  });
});
