/**
 * Database migration tests for Version 10: worktree_memos table
 * TDD Approach: Write tests first (Red), then implement (Green)
 *
 * [Issue #1939] Two tests here inserted into `worktrees(memo)` AFTER the full
 * chain had run and died on `table worktrees has no column named memo`. The
 * column is not missing by accident: migration v13
 * (`rename-worktree-memo-to-description`, src/lib/db/migrations/v11-v15-feature-additions.ts)
 * renames it on purpose. So `worktrees.memo` only exists between v01 and v12,
 * and a test that wants to see it has to stop the chain there. The v10
 * implementation was verified correct — see the partial-chain block at the
 * bottom, which is what those two tests were reaching for and never reached
 * (both carried a "we just verify the table structure" note admitting as much).
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, getCurrentVersion } from '@/lib/db/db-migrations';
import { migrations } from '@/lib/db/migrations';
import { runMigrations as runMigrationsUpTo } from '@/lib/db/migrations/runner';

/** Run the chain only as far as `version`, so mid-chain schemas are observable. */
function migrateTo(db: Database.Database, version: number): void {
  runMigrationsUpTo(db, migrations.filter((m) => m.version <= version));
}

describe('Database Migration: Version 10 - worktree_memos table', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Migration 10: add-worktree-memos-table', () => {
    it('should migrate to version 10', () => {
      runMigrations(testDb);
      const currentVersion = getCurrentVersion(testDb);
      expect(currentVersion).toBeGreaterThanOrEqual(10);
    });

    it('should create worktree_memos table', () => {
      runMigrations(testDb);

      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='worktree_memos'")
        .all() as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('worktree_memos');
    });

    it('should create worktree_memos table with correct columns', () => {
      runMigrations(testDb);

      const columns = testDb.pragma('table_info(worktree_memos)') as Array<{
        name: string;
        type: string;
        notnull: number;
        dflt_value: string | null;
        pk: number;
      }>;

      const columnNames = columns.map((col) => col.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('worktree_id');
      expect(columnNames).toContain('title');
      expect(columnNames).toContain('content');
      expect(columnNames).toContain('position');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');

      // Check column types
      const idCol = columns.find((c) => c.name === 'id');
      expect(idCol?.type).toBe('TEXT');
      expect(idCol?.pk).toBe(1);

      const worktreeIdCol = columns.find((c) => c.name === 'worktree_id');
      expect(worktreeIdCol?.type).toBe('TEXT');
      expect(worktreeIdCol?.notnull).toBe(1);

      const titleCol = columns.find((c) => c.name === 'title');
      expect(titleCol?.type).toBe('TEXT');
      expect(titleCol?.notnull).toBe(1);

      const positionCol = columns.find((c) => c.name === 'position');
      expect(positionCol?.type).toBe('INTEGER');
      expect(positionCol?.notnull).toBe(1);
    });

    it('should create index on worktree_id and position', () => {
      runMigrations(testDb);

      const indexes = testDb
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='worktree_memos'"
        )
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((idx) => idx.name);

      expect(indexNames).toContain('idx_worktree_memos_worktree');
    });

    it('should enforce UNIQUE constraint on (worktree_id, position)', () => {
      runMigrations(testDb);

      // Insert a worktree first
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', Date.now());

      // Insert first memo at position 0
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-1', 'test-worktree', 'Memo 1', 'Content 1', 0, now, now);

      // Attempt to insert another memo at position 0 should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('memo-2', 'test-worktree', 'Memo 2', 'Content 2', 0, now, now);
      }).toThrow(/UNIQUE constraint failed/);
    });

    it('should enforce FOREIGN KEY constraint on worktree_id', () => {
      runMigrations(testDb);

      // Enable foreign key enforcement
      testDb.pragma('foreign_keys = ON');

      const now = Date.now();

      // Attempt to insert memo with non-existent worktree_id should fail
      expect(() => {
        testDb.prepare(`
          INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run('memo-1', 'nonexistent-worktree', 'Memo 1', 'Content 1', 0, now, now);
      }).toThrow(/FOREIGN KEY constraint failed/);
    });

    it('should cascade delete memos when worktree is deleted', () => {
      runMigrations(testDb);

      // Enable foreign key enforcement
      testDb.pragma('foreign_keys = ON');

      // Insert a worktree
      testDb.prepare(`
        INSERT INTO worktrees (id, name, path, updated_at)
        VALUES (?, ?, ?, ?)
      `).run('test-worktree', 'Test', '/path/to/test', Date.now());

      // Insert memos
      const now = Date.now();
      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-1', 'test-worktree', 'Memo 1', 'Content 1', 0, now, now);

      testDb.prepare(`
        INSERT INTO worktree_memos (id, worktree_id, title, content, position, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run('memo-2', 'test-worktree', 'Memo 2', 'Content 2', 1, now, now);

      // Delete the worktree
      testDb.prepare('DELETE FROM worktrees WHERE id = ?').run('test-worktree');

      // Memos should be deleted
      const memos = testDb.prepare('SELECT * FROM worktree_memos WHERE worktree_id = ?').all('test-worktree');
      expect(memos).toHaveLength(0);
    });

    // [Issue #1939] Replaces `should migrate existing memo data from worktrees
    // table`, which asserted that `worktrees.memo` survives the full chain "for
    // backward compatibility". It does not, and that is the product's decision:
    // v13 renames the column to `description`. Assert the rename instead, so the
    // next person to look for `worktrees.memo` finds the answer here.
    it('should end the full chain with worktrees.description, not worktrees.memo (v13 rename)', () => {
      runMigrations(testDb);

      const columnNames = (
        testDb.pragma('table_info(worktrees)') as Array<{ name: string }>
      ).map((c) => c.name);

      expect(columnNames).toContain('description');
      expect(columnNames).not.toContain('memo');
    });

    // [Issue #1939] The original `data migration from existing memos` block ran
    // the WHOLE chain first and then admitted in a comment that it was only
    // checking the table structure — so migration 10's `SELECT id, memo FROM
    // worktrees ... INSERT INTO worktree_memos` copy loop was never executed
    // against real rows by any test. These stop the chain at v9, seed
    // `worktrees.memo` while that column still exists, then apply v10 and assert
    // what it actually carried over.
    describe('data migration from existing memos (partial chain, stops at v9 then applies v10)', () => {
      let seededDb: Database.Database;

      beforeEach(() => {
        seededDb = new Database(':memory:');
        migrateTo(seededDb, 9);

        const now = Date.now();
        const insert = seededDb.prepare(`
          INSERT INTO worktrees (id, name, path, memo, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `);
        insert.run('wt-with-memo', 'With Memo', '/path/to/with-memo', 'Test memo content', now);
        insert.run('wt-empty-memo', 'Empty Memo', '/path/to/empty-memo', '', now);
        insert.run('wt-null-memo', 'Null Memo', '/path/to/null-memo', null, now);

        migrateTo(seededDb, 10);
      });

      afterEach(() => {
        seededDb.close();
      });

      it('should carry a non-empty memo into worktree_memos', () => {
        const rows = seededDb
          .prepare('SELECT worktree_id, title, content, position FROM worktree_memos')
          .all() as Array<{ worktree_id: string; title: string; content: string; position: number }>;

        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          worktree_id: 'wt-with-memo',
          title: 'Memo',
          content: 'Test memo content',
          position: 0,
        });
      });

      it('should skip empty and NULL memos', () => {
        const carried = (
          seededDb.prepare('SELECT worktree_id FROM worktree_memos').all() as Array<{
            worktree_id: string;
          }>
        ).map((r) => r.worktree_id);

        expect(carried).not.toContain('wt-empty-memo');
        expect(carried).not.toContain('wt-null-memo');
      });

      it('should give each carried memo a real UUID rather than a fixed id', () => {
        const { id } = seededDb.prepare('SELECT id FROM worktree_memos').get() as { id: string };

        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
      });

      // The row does NOT keep its seeded `worktree_id`: v54
      // (`worktree-id-path-derived`, Issue #1621) renumbers every worktree to a
      // path-derived ID and drags the child tables along via
      // `renameWorktreeIdPreservingChildren`. Joining through `worktrees` is what
      // makes this an assertion about the memo surviving rather than about which
      // ID it happens to be filed under.
      it('should keep the carried memo through the rest of the chain, following its worktree', () => {
        runMigrations(seededDb);

        const rows = seededDb
          .prepare(
            `SELECT m.content AS content, w.path AS path
               FROM worktree_memos m JOIN worktrees w ON w.id = m.worktree_id`
          )
          .all() as Array<{ content: string; path: string }>;

        expect(rows).toEqual([{ content: 'Test memo content', path: '/path/to/with-memo' }]);
      });
    });
  });
});
