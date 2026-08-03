/**
 * Issue #1621 / #1644 Phase 2: `worktree_aliases` — every ID a worktree has ever
 * answered to, mapped to the ID it answers to now.
 *
 * Freezing the ID (#1644 Phase 1) stops NEW breakage; it does not repair the
 * references that already exist. Rows written under the branch-derived scheme
 * still carry those IDs and #1645 will renumber them, so the URLs a human kept
 * — an open tab, a phone, a PWA shortcut, `commandmate send <id>` in a script —
 * have to keep resolving across that move.
 *
 * These tests cover the migration's schema and the resolution rules that make
 * an alias safe: live worktrees always beat aliases, a rename records its own
 * alias, chains collapse to one hop, and a deleted worktree takes its aliases
 * with it.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { CURRENT_SCHEMA_VERSION } from '@/lib/db/migrations/runner';
import {
  upsertWorktree,
  createMessage,
  migrateWorktreeIdPreservingChildren,
  deleteWorktreesByIds,
  recordWorktreeAlias,
  resolveWorktreeIdWithAlias,
  getWorktreeAliases,
  getAliasedWorktreeIds,
} from '@/lib/db';
import { getWorktreeChildTables } from '@/lib/db/migrations/worktree-child-tables';
import type { Worktree } from '@/types/models';

const REPO_PATH = '/repos/anvil';

function makeWorktree(id: string, worktreePath: string): Worktree {
  return {
    id,
    name: 'develop',
    branch: 'develop',
    path: worktreePath,
    repositoryPath: REPO_PATH,
    repositoryName: 'anvil',
  };
}

function aliasRows(db: Database.Database): Array<{ old_id: string; worktree_id: string }> {
  return db
    .prepare('SELECT old_id, worktree_id FROM worktree_aliases ORDER BY old_id')
    .all() as Array<{ old_id: string; worktree_id: string }>;
}

describe('migration v53: worktree_aliases', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('is part of the current schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(53);
    const applied = db
      .prepare('SELECT name FROM schema_version WHERE version = 53')
      .get() as { name: string } | undefined;
    expect(applied?.name).toBe('add-worktree-aliases');
  });

  it('creates the table with old_id as the primary key and an index on worktree_id', () => {
    const columns = db.prepare('PRAGMA table_info("worktree_aliases")').all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = Object.fromEntries(columns.map((c) => [c.name, c]));

    expect(Object.keys(byName).sort()).toEqual(['created_at', 'old_id', 'worktree_id']);
    expect(byName.old_id.pk).toBe(1);
    expect(byName.worktree_id.notnull).toBe(1);
    expect(byName.created_at.notnull).toBe(1);

    const indexes = db.prepare('PRAGMA index_list("worktree_aliases")').all() as Array<{
      name: string;
    }>;
    expect(indexes.map((i) => i.name)).toContain('idx_worktree_aliases_worktree_id');
  });

  it('declares a cascading foreign key to worktrees(id)', () => {
    const fks = db.prepare('PRAGMA foreign_key_list("worktree_aliases")').all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    expect(fks).toHaveLength(1);
    expect(fks[0]).toMatchObject({
      table: 'worktrees',
      from: 'worktree_id',
      to: 'id',
      on_delete: 'CASCADE',
    });
  });

  it('is discovered as a worktree child table (so renames re-point it)', () => {
    const children = getWorktreeChildTables(db);
    expect(children).toContainEqual({ table: 'worktree_aliases', column: 'worktree_id' });
  });

  it('rolls back cleanly', () => {
    db.exec('DROP INDEX IF EXISTS idx_worktree_aliases_worktree_id;');
    db.exec('DROP TABLE IF EXISTS worktree_aliases;');
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_aliases'")
      .get();
    expect(table).toBeUndefined();
    // Resolution degrades to "no alias" rather than throwing on an older file.
    upsertWorktree(db, makeWorktree('anvil', '/repos/anvil'));
    expect(resolveWorktreeIdWithAlias(db, 'anvil')).toBe('anvil');
    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBeNull();
    expect(getAliasedWorktreeIds(db)).toEqual([]);
  });
});

describe('worktree alias resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
    upsertWorktree(db, makeWorktree('anvil', '/repos/anvil'));
  });

  afterEach(() => {
    db.close();
  });

  it('resolves a live ID to itself', () => {
    expect(resolveWorktreeIdWithAlias(db, 'anvil')).toBe('anvil');
  });

  it('resolves a recorded historical ID to the current one', () => {
    recordWorktreeAlias(db, 'anvil-develop', 'anvil');
    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBe('anvil');
  });

  it('returns null for an ID that is neither live nor aliased', () => {
    expect(resolveWorktreeIdWithAlias(db, 'never-existed')).toBeNull();
    expect(resolveWorktreeIdWithAlias(db, '')).toBeNull();
  });

  it('lets a live worktree win over an alias claiming the same ID', () => {
    recordWorktreeAlias(db, 'anvil-develop', 'anvil');
    // A different directory is later registered under the very ID that used to
    // name the first one. The thing that exists now is the answer.
    upsertWorktree(db, makeWorktree('anvil-develop', '/repos/anvil-develop'));

    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBe('anvil-develop');
  });

  it('refuses to record a self-alias', () => {
    recordWorktreeAlias(db, 'anvil', 'anvil');
    expect(aliasRows(db)).toEqual([]);
  });

  it('drops a stale alias when its old_id becomes a live worktree ID', () => {
    recordWorktreeAlias(db, 'anvil-develop', 'anvil');
    expect(getAliasedWorktreeIds(db)).toEqual(['anvil-develop']);

    // `anvil-develop` is now a destination, not a retired name.
    upsertWorktree(db, makeWorktree('anvil-develop', '/repos/anvil-develop'));
    recordWorktreeAlias(db, 'anvil-old', 'anvil-develop');

    expect(aliasRows(db)).toEqual([
      { old_id: 'anvil-old', worktree_id: 'anvil-develop' },
    ]);
  });

  it('ignores an alias whose target worktree is gone', () => {
    recordWorktreeAlias(db, 'anvil-develop', 'anvil');
    // Force a dangling row (only reachable with foreign keys off).
    db.pragma('foreign_keys = OFF');
    db.prepare('DELETE FROM worktrees WHERE id = ?').run('anvil');
    db.pragma('foreign_keys = ON');

    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBeNull();
  });

  it('lists a worktree’s historical IDs', () => {
    recordWorktreeAlias(db, 'anvil-develop', 'anvil', 1000);
    recordWorktreeAlias(db, 'anvil-main', 'anvil', 2000);

    expect(getWorktreeAliases(db, 'anvil').map((a) => a.oldId)).toEqual([
      'anvil-main',
      'anvil-develop',
    ]);
    expect(getAliasedWorktreeIds(db).sort()).toEqual(['anvil-develop', 'anvil-main']);
  });
});

describe('renaming a worktree records its own alias', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
    db.pragma('foreign_keys = ON');
  });

  afterEach(() => {
    db.close();
  });

  it('makes the old ID resolve to the new one after a rename', () => {
    upsertWorktree(db, makeWorktree('anvil-develop', '/repos/anvil'));
    createMessage(db, {
      worktreeId: 'anvil-develop',
      role: 'user',
      content: 'hello',
      timestamp: new Date(),
      messageType: 'normal',
    });

    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'anvil-develop', 'anvil');
    })();

    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBe('anvil');
    expect(aliasRows(db)).toEqual([{ old_id: 'anvil-develop', worktree_id: 'anvil' }]);
  });

  it('collapses A -> B -> C to one hop instead of a chain', () => {
    upsertWorktree(db, makeWorktree('id-a', '/repos/anvil'));

    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'id-a', 'id-b');
    })();
    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'id-b', 'id-c');
    })();

    // Both historical IDs point straight at the current one; resolution never
    // has to walk a chain (and so can never loop).
    expect(aliasRows(db)).toEqual([
      { old_id: 'id-a', worktree_id: 'id-c' },
      { old_id: 'id-b', worktree_id: 'id-c' },
    ]);
    expect(resolveWorktreeIdWithAlias(db, 'id-a')).toBe('id-c');
    expect(resolveWorktreeIdWithAlias(db, 'id-b')).toBe('id-c');
  });

  it('records the alias on the ID-collision merge path too', () => {
    upsertWorktree(db, makeWorktree('wt-old', '/repos/anvil-old'));
    upsertWorktree(db, makeWorktree('wt-new', '/repos/anvil-new'));

    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'wt-old', 'wt-new');
    })();

    expect(resolveWorktreeIdWithAlias(db, 'wt-old')).toBe('wt-new');
  });

  it('records nothing for a no-op rename', () => {
    upsertWorktree(db, makeWorktree('anvil', '/repos/anvil'));

    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'anvil', 'anvil');
      migrateWorktreeIdPreservingChildren(db, 'does-not-exist', 'anvil');
    })();

    expect(aliasRows(db)).toEqual([]);
  });

  it('takes aliases with the worktree when it is deleted', () => {
    upsertWorktree(db, makeWorktree('anvil-develop', '/repos/anvil'));
    db.transaction(() => {
      migrateWorktreeIdPreservingChildren(db, 'anvil-develop', 'anvil');
    })();
    expect(aliasRows(db)).toHaveLength(1);

    deleteWorktreesByIds(db, ['anvil']);

    expect(aliasRows(db)).toEqual([]);
    expect(resolveWorktreeIdWithAlias(db, 'anvil-develop')).toBeNull();
  });
});
