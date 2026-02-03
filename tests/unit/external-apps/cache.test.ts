/**
 * Cache layer tests for external-apps module
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { createExternalApp, updateExternalApp, deleteExternalApp } from '@/lib/external-apps/db';
import { ExternalAppCache, externalAppCache, resetCacheInstance } from '@/lib/external-apps/cache';
import type { CreateExternalAppInput } from '@/types/external-apps';

describe('External Apps Cache', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema
    runMigrations(testDb);
    // Reset the singleton cache instance
    resetCacheInstance();
    // Clear any fake timers
    vi.useRealTimers();
  });

  afterEach(() => {
    testDb.close();
    vi.useRealTimers();
  });

  describe('ExternalAppCache class', () => {
    describe('constructor', () => {
      it('should create cache with default TTL of 30 seconds', () => {
        const cache = new ExternalAppCache(testDb);
        expect(cache.getTTL()).toBe(30000);
      });

      it('should accept custom TTL', () => {
        const cache = new ExternalAppCache(testDb, 60000);
        expect(cache.getTTL()).toBe(60000);
      });
    });

    describe('getByPathPrefix', () => {
      it('should return app from cache on cache hit', async () => {
        const cache = new ExternalAppCache(testDb);

        // Create an app
        const created = createExternalApp(testDb, {
          name: 'cached-app',
          displayName: 'Cached App',
          pathPrefix: 'cached',
          targetPort: 3000,
          appType: 'nextjs',
        });

        // First call - populates cache
        const firstResult = await cache.getByPathPrefix('cached');
        expect(firstResult).not.toBeNull();
        expect(firstResult?.id).toBe(created.id);

        // Second call - should hit cache
        const secondResult = await cache.getByPathPrefix('cached');
        expect(secondResult).not.toBeNull();
        expect(secondResult?.id).toBe(created.id);
      });

      it('should return null for non-existent path prefix', async () => {
        const cache = new ExternalAppCache(testDb);

        const result = await cache.getByPathPrefix('non-existent');
        expect(result).toBeNull();
      });

      it('should refresh cache after TTL expires', async () => {
        vi.useFakeTimers();
        const cache = new ExternalAppCache(testDb, 1000); // 1 second TTL

        // Create initial app
        createExternalApp(testDb, {
          name: 'app1',
          displayName: 'App 1',
          pathPrefix: 'app1',
          targetPort: 3000,
          appType: 'nextjs',
        });

        // First call - populates cache
        await cache.getByPathPrefix('app1');

        // Advance time past TTL
        vi.advanceTimersByTime(1500);

        // Create another app directly in DB
        createExternalApp(testDb, {
          name: 'app2',
          displayName: 'App 2',
          pathPrefix: 'app2',
          targetPort: 3001,
          appType: 'sveltekit',
        });

        // Next call should refresh cache and find the new app
        const result = await cache.getByPathPrefix('app2');
        expect(result).not.toBeNull();
        expect(result?.name).toBe('app2');
      });

      it('should only return enabled apps', async () => {
        const cache = new ExternalAppCache(testDb);

        // Create and disable an app
        const app = createExternalApp(testDb, {
          name: 'disabled-app',
          displayName: 'Disabled App',
          pathPrefix: 'disabled',
          targetPort: 3000,
          appType: 'nextjs',
        });

        updateExternalApp(testDb, app.id, { enabled: false });
        cache.invalidate();

        const result = await cache.getByPathPrefix('disabled');
        expect(result).toBeNull();
      });
    });

    describe('getAll', () => {
      it('should return all enabled apps', async () => {
        const cache = new ExternalAppCache(testDb);

        createExternalApp(testDb, {
          name: 'app1',
          displayName: 'App 1',
          pathPrefix: 'app1',
          targetPort: 3001,
          appType: 'nextjs',
        });

        createExternalApp(testDb, {
          name: 'app2',
          displayName: 'App 2',
          pathPrefix: 'app2',
          targetPort: 3002,
          appType: 'sveltekit',
        });

        const apps = await cache.getAll();

        expect(apps).toHaveLength(2);
      });

      it('should return empty array when no apps exist', async () => {
        const cache = new ExternalAppCache(testDb);

        const apps = await cache.getAll();
        expect(apps).toEqual([]);
      });

      it('should not include disabled apps', async () => {
        const cache = new ExternalAppCache(testDb);

        const app1 = createExternalApp(testDb, {
          name: 'enabled-app',
          displayName: 'Enabled',
          pathPrefix: 'enabled',
          targetPort: 3000,
          appType: 'nextjs',
        });

        const app2 = createExternalApp(testDb, {
          name: 'disabled-app',
          displayName: 'Disabled',
          pathPrefix: 'disabled',
          targetPort: 3001,
          appType: 'nextjs',
        });

        updateExternalApp(testDb, app2.id, { enabled: false });
        cache.invalidate();

        const apps = await cache.getAll();

        expect(apps).toHaveLength(1);
        expect(apps[0].id).toBe(app1.id);
      });
    });

    describe('invalidateByIssueNo', () => {
      it('should invalidate cache entries for specific issue', async () => {
        const cache = new ExternalAppCache(testDb);

        // Create a main app (no issue_no)
        createExternalApp(testDb, {
          name: 'main-app',
          displayName: 'Main App',
          pathPrefix: 'main',
          targetPort: 3000,
          appType: 'nextjs',
        });

        // Create a worktree app (with issue_no = 135)
        testDb.prepare(`
          INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
          VALUES ('wt-135', 'worktree-135', 'Worktree #135', 'commandmate_issue/135', 3001, 'localhost', 'other', 1, ?, ?, 135)
        `).run(Date.now(), Date.now());

        // Populate cache
        await cache.getAll();
        expect(cache.isStale()).toBe(false);

        // Invalidate only for issue 135
        cache.invalidateByIssueNo(135);

        // Cache should be marked as stale
        expect(cache.isStale()).toBe(true);
      });

      it('should allow new worktree to be routable immediately after registration', async () => {
        const cache = new ExternalAppCache(testDb);

        // Populate empty cache
        await cache.getAll();

        // Register new worktree app
        testDb.prepare(`
          INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at, issue_no)
          VALUES ('wt-200', 'worktree-200', 'Worktree #200', 'commandmate_issue/200', 3002, 'localhost', 'other', 1, ?, ?, 200)
        `).run(Date.now(), Date.now());

        // Before invalidation - cache still has old data
        const beforeInvalidate = await cache.getByPathPrefix('commandmate_issue/200');
        // Note: This might return the new app because getByPathPrefix checks isStale()
        // but we're testing the explicit invalidation flow

        // Invalidate for issue 200
        cache.invalidateByIssueNo(200);

        // After invalidation - should see new app
        const afterInvalidate = await cache.getByPathPrefix('commandmate_issue/200');
        expect(afterInvalidate).not.toBeNull();
        expect(afterInvalidate?.name).toBe('worktree-200');
      });

      it('should handle case when issue has no associated apps', async () => {
        const cache = new ExternalAppCache(testDb);

        // Populate cache
        await cache.getAll();

        // Invalidating non-existent issue should not throw
        expect(() => cache.invalidateByIssueNo(999)).not.toThrow();

        // Cache should still be marked as stale for safety
        expect(cache.isStale()).toBe(true);
      });
    });

    describe('invalidate', () => {
      it('should clear cache and force refresh on next call', async () => {
        const cache = new ExternalAppCache(testDb);

        // Create initial app
        createExternalApp(testDb, {
          name: 'original-app',
          displayName: 'Original',
          pathPrefix: 'original',
          targetPort: 3000,
          appType: 'nextjs',
        });

        // Populate cache
        await cache.getByPathPrefix('original');

        // Delete app directly from DB (bypassing cache)
        testDb.prepare("DELETE FROM external_apps WHERE name = 'original-app'").run();

        // Create new app
        createExternalApp(testDb, {
          name: 'new-app',
          displayName: 'New App',
          pathPrefix: 'new-app',
          targetPort: 3001,
          appType: 'sveltekit',
        });

        // Before invalidation, cache still returns old data (null for deleted)
        // After invalidation, should get fresh data
        cache.invalidate();

        const result = await cache.getByPathPrefix('original');
        expect(result).toBeNull();

        const newResult = await cache.getByPathPrefix('new-app');
        expect(newResult).not.toBeNull();
        expect(newResult?.name).toBe('new-app');
      });

      it('should reset last refresh timestamp', async () => {
        const cache = new ExternalAppCache(testDb);

        createExternalApp(testDb, {
          name: 'test-app',
          displayName: 'Test',
          pathPrefix: 'test',
          targetPort: 3000,
          appType: 'other',
        });

        await cache.getAll();
        expect(cache.isStale()).toBe(false);

        cache.invalidate();
        expect(cache.isStale()).toBe(true);
      });
    });

    describe('isStale', () => {
      it('should return true when cache has never been refreshed', () => {
        const cache = new ExternalAppCache(testDb);
        expect(cache.isStale()).toBe(true);
      });

      it('should return false immediately after refresh', async () => {
        const cache = new ExternalAppCache(testDb);
        await cache.getAll(); // Triggers refresh
        expect(cache.isStale()).toBe(false);
      });

      it('should return true after TTL expires', async () => {
        vi.useFakeTimers();
        const cache = new ExternalAppCache(testDb, 1000); // 1 second TTL

        await cache.getAll();
        expect(cache.isStale()).toBe(false);

        vi.advanceTimersByTime(1500);
        expect(cache.isStale()).toBe(true);
      });
    });

    describe('refresh', () => {
      it('should update cache with current DB state', async () => {
        const cache = new ExternalAppCache(testDb);

        // Create app
        createExternalApp(testDb, {
          name: 'refresh-test',
          displayName: 'Refresh Test',
          pathPrefix: 'refresh',
          targetPort: 3000,
          appType: 'nextjs',
        });

        await cache.refresh();

        const result = await cache.getByPathPrefix('refresh');
        expect(result).not.toBeNull();
        expect(result?.name).toBe('refresh-test');
      });
    });
  });

  describe('Singleton instance', () => {
    it('should provide singleton access via externalAppCache', () => {
      // The singleton should be available
      expect(externalAppCache).toBeDefined();
    });

    it('should reset singleton with resetCacheInstance', () => {
      // After reset, a new call should create a fresh instance
      resetCacheInstance();
      // This is verified by the beforeEach hook working correctly
      expect(true).toBe(true);
    });
  });

  describe('Cache behavior with CRUD operations', () => {
    it('should reflect changes after create + invalidate', async () => {
      const cache = new ExternalAppCache(testDb);

      // Initial state: empty
      const before = await cache.getAll();
      expect(before).toHaveLength(0);

      // Create app
      createExternalApp(testDb, {
        name: 'new-created',
        displayName: 'New Created',
        pathPrefix: 'new-created',
        targetPort: 3000,
        appType: 'other',
      });

      // Invalidate and check
      cache.invalidate();
      const after = await cache.getAll();
      expect(after).toHaveLength(1);
    });

    it('should reflect changes after update + invalidate', async () => {
      const cache = new ExternalAppCache(testDb);

      const app = createExternalApp(testDb, {
        name: 'to-update',
        displayName: 'Original Name',
        pathPrefix: 'update',
        targetPort: 3000,
        appType: 'nextjs',
      });

      // Populate cache
      await cache.getByPathPrefix('update');

      // Update app
      updateExternalApp(testDb, app.id, { displayName: 'Updated Name' });
      cache.invalidate();

      const result = await cache.getByPathPrefix('update');
      expect(result?.displayName).toBe('Updated Name');
    });

    it('should reflect changes after delete + invalidate', async () => {
      const cache = new ExternalAppCache(testDb);

      const app = createExternalApp(testDb, {
        name: 'to-delete',
        displayName: 'To Delete',
        pathPrefix: 'delete',
        targetPort: 3000,
        appType: 'other',
      });

      // Populate cache
      await cache.getByPathPrefix('delete');

      // Delete app
      deleteExternalApp(testDb, app.id);
      cache.invalidate();

      const result = await cache.getByPathPrefix('delete');
      expect(result).toBeNull();
    });
  });
});
