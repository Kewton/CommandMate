/**
 * Database operations tests for external-apps module
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, CURRENT_SCHEMA_VERSION } from '@/lib/db-migrations';
import type { ExternalApp, CreateExternalAppInput, UpdateExternalAppInput } from '@/types/external-apps';
import {
  createExternalApp,
  getExternalAppById,
  getExternalAppByPathPrefix,
  getAllExternalApps,
  getEnabledExternalApps,
  updateExternalApp,
  deleteExternalApp,
  mapDbRowToExternalApp,
  mapExternalAppToDbRow,
} from '@/lib/external-apps/db';

describe('External Apps Database Operations', () => {
  let testDb: Database.Database;

  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    // Run migrations to set up latest schema (including v12)
    runMigrations(testDb);
  });

  afterEach(() => {
    testDb.close();
  });

  describe('Database Schema (v12 migration)', () => {
    it('should create external_apps table', () => {
      const tables = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='external_apps'")
        .all() as Array<{ name: string }>;

      expect(tables).toHaveLength(1);
      expect(tables[0].name).toBe('external_apps');
    });

    it('should create required columns', () => {
      const columns = testDb
        .prepare("PRAGMA table_info(external_apps)")
        .all() as Array<{ name: string; type: string; notnull: number }>;

      const columnNames = columns.map(c => c.name);

      expect(columnNames).toContain('id');
      expect(columnNames).toContain('name');
      expect(columnNames).toContain('display_name');
      expect(columnNames).toContain('description');
      expect(columnNames).toContain('path_prefix');
      expect(columnNames).toContain('target_port');
      expect(columnNames).toContain('target_host');
      expect(columnNames).toContain('app_type');
      expect(columnNames).toContain('websocket_enabled');
      expect(columnNames).toContain('websocket_path_pattern');
      expect(columnNames).toContain('enabled');
      expect(columnNames).toContain('created_at');
      expect(columnNames).toContain('updated_at');
    });

    it('should create indexes for path_prefix and enabled', () => {
      const indexes = testDb
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_external_apps%'")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map(i => i.name);

      expect(indexNames).toContain('idx_external_apps_path_prefix');
      expect(indexNames).toContain('idx_external_apps_enabled');
    });

    it('should have correct schema version', () => {
      // Schema version should be at least 12 (the version that adds external_apps)
      expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(12);
    });
  });

  describe('DB Row Mapping', () => {
    describe('mapDbRowToExternalApp', () => {
      it('should convert DB row to ExternalApp object', () => {
        const dbRow = {
          id: 'uuid-123',
          name: 'test-app',
          display_name: 'Test App',
          description: 'A test application',
          path_prefix: 'test',
          target_port: 3000,
          target_host: 'localhost',
          app_type: 'nextjs',
          websocket_enabled: 1,
          websocket_path_pattern: '/ws/*',
          enabled: 1,
          created_at: 1700000000000,
          updated_at: 1700001000000,
          issue_no: null, // Issue #136: Added issue_no field
        };

        const app = mapDbRowToExternalApp(dbRow);

        expect(app.id).toBe('uuid-123');
        expect(app.name).toBe('test-app');
        expect(app.displayName).toBe('Test App');
        expect(app.description).toBe('A test application');
        expect(app.pathPrefix).toBe('test');
        expect(app.targetPort).toBe(3000);
        expect(app.targetHost).toBe('localhost');
        expect(app.appType).toBe('nextjs');
        expect(app.websocketEnabled).toBe(true);
        expect(app.websocketPathPattern).toBe('/ws/*');
        expect(app.enabled).toBe(true);
        expect(app.createdAt).toBe(1700000000000);
        expect(app.updatedAt).toBe(1700001000000);
      });

      it('should handle null optional fields', () => {
        const dbRow = {
          id: 'uuid-456',
          name: 'minimal-app',
          display_name: 'Minimal App',
          description: null,
          path_prefix: 'minimal',
          target_port: 5000,
          target_host: 'localhost',
          app_type: 'other',
          websocket_enabled: 0,
          websocket_path_pattern: null,
          enabled: 0,
          created_at: 1700000000000,
          updated_at: 1700000000000,
          issue_no: null, // Issue #136: Added issue_no field
        };

        const app = mapDbRowToExternalApp(dbRow);

        expect(app.description).toBeUndefined();
        expect(app.websocketPathPattern).toBeUndefined();
        expect(app.websocketEnabled).toBe(false);
        expect(app.enabled).toBe(false);
      });
    });

    describe('mapExternalAppToDbRow', () => {
      it('should convert CreateExternalAppInput to DB row format', () => {
        const input: CreateExternalAppInput = {
          name: 'new-app',
          displayName: 'New App',
          description: 'A new application',
          pathPrefix: 'new',
          targetPort: 4000,
          targetHost: '127.0.0.1',
          appType: 'sveltekit',
          websocketEnabled: true,
          websocketPathPattern: '/hmr',
        };

        const dbRow = mapExternalAppToDbRow(input);

        expect(dbRow.name).toBe('new-app');
        expect(dbRow.display_name).toBe('New App');
        expect(dbRow.description).toBe('A new application');
        expect(dbRow.path_prefix).toBe('new');
        expect(dbRow.target_port).toBe(4000);
        expect(dbRow.target_host).toBe('127.0.0.1');
        expect(dbRow.app_type).toBe('sveltekit');
        expect(dbRow.websocket_enabled).toBe(1);
        expect(dbRow.websocket_path_pattern).toBe('/hmr');
      });

      it('should use default values for optional fields', () => {
        const input: CreateExternalAppInput = {
          name: 'simple-app',
          displayName: 'Simple App',
          pathPrefix: 'simple',
          targetPort: 3000,
          appType: 'nextjs',
        };

        const dbRow = mapExternalAppToDbRow(input);

        expect(dbRow.description).toBeNull();
        expect(dbRow.target_host).toBe('localhost');
        expect(dbRow.websocket_enabled).toBe(0);
        expect(dbRow.websocket_path_pattern).toBeNull();
      });
    });
  });

  describe('CRUD Operations', () => {
    describe('createExternalApp', () => {
      it('should create a new external app', () => {
        const input: CreateExternalAppInput = {
          name: 'sveltekit-app',
          displayName: 'SvelteKit App',
          description: 'A SvelteKit application',
          pathPrefix: 'app-svelte',
          targetPort: 5173,
          appType: 'sveltekit',
          websocketEnabled: true,
          websocketPathPattern: '.*',
        };

        const created = createExternalApp(testDb, input);

        expect(created.id).toBeDefined();
        expect(created.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        expect(created.name).toBe('sveltekit-app');
        expect(created.displayName).toBe('SvelteKit App');
        expect(created.pathPrefix).toBe('app-svelte');
        expect(created.targetPort).toBe(5173);
        expect(created.targetHost).toBe('localhost');
        expect(created.appType).toBe('sveltekit');
        expect(created.websocketEnabled).toBe(true);
        expect(created.enabled).toBe(true);
        expect(created.createdAt).toBeDefined();
        expect(created.updatedAt).toBeDefined();
      });

      it('should fail on duplicate name', () => {
        const input: CreateExternalAppInput = {
          name: 'unique-app',
          displayName: 'Unique App',
          pathPrefix: 'unique1',
          targetPort: 3000,
          appType: 'other',
        };

        createExternalApp(testDb, input);

        expect(() => {
          createExternalApp(testDb, { ...input, pathPrefix: 'unique2' });
        }).toThrow();
      });

      it('should fail on duplicate path_prefix', () => {
        const input: CreateExternalAppInput = {
          name: 'app1',
          displayName: 'App 1',
          pathPrefix: 'shared-prefix',
          targetPort: 3000,
          appType: 'other',
        };

        createExternalApp(testDb, input);

        expect(() => {
          createExternalApp(testDb, { ...input, name: 'app2' });
        }).toThrow();
      });
    });

    describe('getExternalAppById', () => {
      it('should return app by ID', () => {
        const created = createExternalApp(testDb, {
          name: 'test-app',
          displayName: 'Test App',
          pathPrefix: 'test',
          targetPort: 3000,
          appType: 'nextjs',
        });

        const found = getExternalAppById(testDb, created.id);

        expect(found).not.toBeNull();
        expect(found?.id).toBe(created.id);
        expect(found?.name).toBe('test-app');
      });

      it('should return null for non-existent ID', () => {
        const found = getExternalAppById(testDb, 'non-existent-id');
        expect(found).toBeNull();
      });
    });

    describe('getExternalAppByPathPrefix', () => {
      it('should return app by path prefix', () => {
        createExternalApp(testDb, {
          name: 'svelte-app',
          displayName: 'Svelte App',
          pathPrefix: 'app-svelte',
          targetPort: 5173,
          appType: 'sveltekit',
        });

        const found = getExternalAppByPathPrefix(testDb, 'app-svelte');

        expect(found).not.toBeNull();
        expect(found?.pathPrefix).toBe('app-svelte');
        expect(found?.name).toBe('svelte-app');
      });

      it('should return null for non-existent path prefix', () => {
        const found = getExternalAppByPathPrefix(testDb, 'non-existent');
        expect(found).toBeNull();
      });
    });

    describe('getAllExternalApps', () => {
      it('should return empty array when no apps exist', () => {
        const apps = getAllExternalApps(testDb);
        expect(apps).toEqual([]);
      });

      it('should return all apps', () => {
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

        const apps = getAllExternalApps(testDb);

        expect(apps).toHaveLength(2);
      });
    });

    describe('getEnabledExternalApps', () => {
      it('should return only enabled apps', () => {
        const app1 = createExternalApp(testDb, {
          name: 'enabled-app',
          displayName: 'Enabled App',
          pathPrefix: 'enabled',
          targetPort: 3001,
          appType: 'nextjs',
        });

        const app2 = createExternalApp(testDb, {
          name: 'disabled-app',
          displayName: 'Disabled App',
          pathPrefix: 'disabled',
          targetPort: 3002,
          appType: 'nextjs',
        });

        // Disable the second app
        updateExternalApp(testDb, app2.id, { enabled: false });

        const enabledApps = getEnabledExternalApps(testDb);

        expect(enabledApps).toHaveLength(1);
        expect(enabledApps[0].id).toBe(app1.id);
        expect(enabledApps[0].enabled).toBe(true);
      });
    });

    describe('updateExternalApp', () => {
      it('should update app fields', () => {
        const created = createExternalApp(testDb, {
          name: 'original-app',
          displayName: 'Original Name',
          pathPrefix: 'original',
          targetPort: 3000,
          appType: 'nextjs',
        });

        const update: UpdateExternalAppInput = {
          displayName: 'Updated Name',
          description: 'Added description',
          targetPort: 4000,
          enabled: false,
        };

        const updated = updateExternalApp(testDb, created.id, update);

        expect(updated.displayName).toBe('Updated Name');
        expect(updated.description).toBe('Added description');
        expect(updated.targetPort).toBe(4000);
        expect(updated.enabled).toBe(false);
        expect(updated.name).toBe('original-app'); // Unchanged
        expect(updated.pathPrefix).toBe('original'); // Unchanged
        expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt);
      });

      it('should throw error for non-existent app', () => {
        expect(() => {
          updateExternalApp(testDb, 'non-existent-id', { displayName: 'New Name' });
        }).toThrow();
      });

      it('should update only provided fields', () => {
        const created = createExternalApp(testDb, {
          name: 'partial-update',
          displayName: 'Original',
          description: 'Original description',
          pathPrefix: 'partial',
          targetPort: 3000,
          appType: 'other',
        });

        const updated = updateExternalApp(testDb, created.id, {
          displayName: 'New Name',
        });

        expect(updated.displayName).toBe('New Name');
        expect(updated.description).toBe('Original description'); // Unchanged
        expect(updated.targetPort).toBe(3000); // Unchanged
      });
    });

    describe('deleteExternalApp', () => {
      it('should delete app by ID', () => {
        const created = createExternalApp(testDb, {
          name: 'to-delete',
          displayName: 'To Delete',
          pathPrefix: 'delete',
          targetPort: 3000,
          appType: 'other',
        });

        deleteExternalApp(testDb, created.id);

        const found = getExternalAppById(testDb, created.id);
        expect(found).toBeNull();
      });

      it('should not throw for non-existent app', () => {
        expect(() => {
          deleteExternalApp(testDb, 'non-existent-id');
        }).not.toThrow();
      });
    });
  });

  describe('Validation', () => {
    it('should enforce app_type CHECK constraint', () => {
      expect(() => {
        testDb.prepare(`
          INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at)
          VALUES ('test-id', 'test', 'Test', 'test', 3000, 'localhost', 'invalid_type', 1, ?, ?)
        `).run(Date.now(), Date.now());
      }).toThrow();
    });

    it('should allow valid app_type values', () => {
      const validTypes = ['sveltekit', 'streamlit', 'nextjs', 'other'];
      const now = Date.now();

      for (const appType of validTypes) {
        const id = `test-${appType}`;
        expect(() => {
          testDb.prepare(`
            INSERT INTO external_apps (id, name, display_name, path_prefix, target_port, target_host, app_type, enabled, created_at, updated_at)
            VALUES (?, ?, ?, ?, 3000, 'localhost', ?, 1, ?, ?)
          `).run(id, `app-${appType}`, `App ${appType}`, `prefix-${appType}`, appType, now, now);
        }).not.toThrow();
      }
    });
  });
});
