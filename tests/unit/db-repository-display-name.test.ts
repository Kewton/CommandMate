/**
 * Unit Tests: Repository display_name feature
 * Issue #642: Add display_name (alias) to repositories
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createRepository,
  getRepositoryById,
  updateRepository,
  getAllRepositories,
} from '@/lib/db/db-repository';

describe('Repository display_name feature (Issue #642)', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('migration: display_name column exists', () => {
    it('should have display_name column in repositories table', () => {
      const columns = db.pragma('table_info(repositories)') as Array<{ name: string }>;
      const columnNames = columns.map((c) => c.name);
      expect(columnNames).toContain('display_name');
    });
  });

  describe('createRepository with displayName', () => {
    it('should create repository without displayName (null by default)', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      expect(repo.displayName).toBeUndefined();

      // Verify from DB
      const fetched = getRepositoryById(db, repo.id);
      expect(fetched!.displayName).toBeUndefined();
    });
  });

  describe('updateRepository with displayName', () => {
    it('should update displayName', () => {
      const repo = createRepository(db, {
        name: 'my-long-directory-name',
        path: '/path/to/my-long-directory-name',
        cloneSource: 'local',
      });

      updateRepository(db, repo.id, { displayName: 'My Project' });

      const updated = getRepositoryById(db, repo.id);
      expect(updated!.displayName).toBe('My Project');
    });

    it('should clear displayName by setting empty string', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      // Set displayName
      updateRepository(db, repo.id, { displayName: 'Alias' });
      let updated = getRepositoryById(db, repo.id);
      expect(updated!.displayName).toBe('Alias');

      // Clear displayName with empty string
      updateRepository(db, repo.id, { displayName: '' });
      updated = getRepositoryById(db, repo.id);
      expect(updated!.displayName).toBeUndefined();
    });

    it('should not affect displayName when updating other fields', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      updateRepository(db, repo.id, { displayName: 'My Alias' });
      updateRepository(db, repo.id, { name: 'new-name' });

      const updated = getRepositoryById(db, repo.id);
      expect(updated!.name).toBe('new-name');
      expect(updated!.displayName).toBe('My Alias');
    });
  });

  describe('getAllRepositories with displayName', () => {
    it('should include displayName in results', () => {
      createRepository(db, {
        name: 'repo-a',
        path: '/path/to/repo-a',
        cloneSource: 'local',
      });

      const repoB = createRepository(db, {
        name: 'repo-b',
        path: '/path/to/repo-b',
        cloneSource: 'local',
      });

      updateRepository(db, repoB.id, { displayName: 'Project B' });

      const repos = getAllRepositories(db);
      const repoAResult = repos.find((r) => r.name === 'repo-a');
      const repoBResult = repos.find((r) => r.name === 'repo-b');

      expect(repoAResult!.displayName).toBeUndefined();
      expect(repoBResult!.displayName).toBe('Project B');
    });
  });
});
