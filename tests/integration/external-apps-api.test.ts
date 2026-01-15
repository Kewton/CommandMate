/**
 * External Apps API Integration Tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 * Issue #42: Proxy routing for multiple frontend applications
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { createExternalApp } from '@/lib/external-apps/db';
import type { CreateExternalAppInput, ExternalApp } from '@/types/external-apps';

// Mock the database instance
vi.mock('@/lib/db-instance', () => {
  let mockDb: Database.Database | null = null;

  return {
    getDbInstance: () => {
      if (!mockDb) {
        throw new Error('Mock database not initialized');
      }
      return mockDb;
    },
    setMockDb: (db: Database.Database) => {
      mockDb = db;
    },
    closeDbInstance: () => {
      if (mockDb) {
        mockDb.close();
        mockDb = null;
      }
    },
  };
});

describe('External Apps API', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db-instance');
    (setMockDb as (db: Database.Database) => void)(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  describe('GET /api/external-apps', () => {
    it('should return empty array when no apps exist', async () => {
      const { GET } = await import('@/app/api/external-apps/route');

      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.apps).toEqual([]);
    });

    it('should return all apps', async () => {
      // Create test apps
      createExternalApp(db, {
        name: 'svelte-app',
        displayName: 'Svelte App',
        pathPrefix: 'app-svelte',
        targetPort: 5173,
        appType: 'sveltekit',
      });

      createExternalApp(db, {
        name: 'streamlit-app',
        displayName: 'Streamlit App',
        pathPrefix: 'app-streamlit',
        targetPort: 8501,
        appType: 'streamlit',
      });

      const { GET } = await import('@/app/api/external-apps/route');

      const response = await GET();

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.apps).toHaveLength(2);
    });
  });

  describe('POST /api/external-apps', () => {
    it('should create a new app with valid input', async () => {
      const { POST } = await import('@/app/api/external-apps/route');

      const input: CreateExternalAppInput = {
        name: 'new-app',
        displayName: 'New App',
        pathPrefix: 'new-app',
        targetPort: 3001,
        appType: 'nextjs',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(201);

      const data = await response.json();
      expect(data.app.name).toBe('new-app');
      expect(data.app.id).toBeDefined();
    });

    it('should return 400 for invalid port (below range)', async () => {
      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'invalid-port-app',
        displayName: 'Invalid Port App',
        pathPrefix: 'invalid',
        targetPort: 80, // Below 1024
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('targetPort');
    });

    it('should return 400 for invalid port (above range)', async () => {
      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'invalid-port-app',
        displayName: 'Invalid Port App',
        pathPrefix: 'invalid',
        targetPort: 70000, // Above 65535
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('targetPort');
    });

    it('should return 400 for invalid host', async () => {
      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'remote-app',
        displayName: 'Remote App',
        pathPrefix: 'remote',
        targetPort: 3000,
        targetHost: '192.168.1.100', // Not localhost or 127.0.0.1
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('targetHost');
    });

    it('should return 400 for invalid pathPrefix format', async () => {
      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'invalid-prefix',
        displayName: 'Invalid Prefix App',
        pathPrefix: 'invalid/prefix', // Contains slash
        targetPort: 3000,
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(400);

      const data = await response.json();
      expect(data.error).toContain('pathPrefix');
    });

    it('should return 409 for duplicate name', async () => {
      // Create initial app
      createExternalApp(db, {
        name: 'existing-app',
        displayName: 'Existing App',
        pathPrefix: 'existing',
        targetPort: 3000,
        appType: 'other',
      });

      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'existing-app', // Duplicate name
        displayName: 'New App',
        pathPrefix: 'new-prefix',
        targetPort: 3001,
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
    });

    it('should return 409 for duplicate pathPrefix', async () => {
      // Create initial app
      createExternalApp(db, {
        name: 'app1',
        displayName: 'App 1',
        pathPrefix: 'shared-prefix',
        targetPort: 3000,
        appType: 'other',
      });

      const { POST } = await import('@/app/api/external-apps/route');

      const input = {
        name: 'app2',
        displayName: 'App 2',
        pathPrefix: 'shared-prefix', // Duplicate pathPrefix
        targetPort: 3001,
        appType: 'other',
      };

      const request = new Request('http://localhost:3000/api/external-apps', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });

      const response = await POST(request);

      expect(response.status).toBe(409);
    });
  });

  describe('GET /api/external-apps/[id]', () => {
    it('should return app by ID', async () => {
      const created = createExternalApp(db, {
        name: 'test-app',
        displayName: 'Test App',
        pathPrefix: 'test',
        targetPort: 3000,
        appType: 'nextjs',
      });

      const { GET } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}`);
      const response = await GET(request, { params: Promise.resolve({ id: created.id }) });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.app.id).toBe(created.id);
      expect(data.app.name).toBe('test-app');
    });

    it('should return 404 for non-existent app', async () => {
      const { GET } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request('http://localhost:3000/api/external-apps/non-existent');
      const response = await GET(request, { params: Promise.resolve({ id: 'non-existent' }) });

      expect(response.status).toBe(404);

      const data = await response.json();
      expect(data.error).toContain('not found');
    });
  });

  describe('PATCH /api/external-apps/[id]', () => {
    it('should update app fields', async () => {
      const created = createExternalApp(db, {
        name: 'original-app',
        displayName: 'Original Name',
        pathPrefix: 'original',
        targetPort: 3000,
        appType: 'nextjs',
      });

      const { PATCH } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: 'Updated Name',
          description: 'Added description',
          targetPort: 4000,
        }),
      });

      const response = await PATCH(request, { params: Promise.resolve({ id: created.id }) });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.app.displayName).toBe('Updated Name');
      expect(data.app.description).toBe('Added description');
      expect(data.app.targetPort).toBe(4000);
    });

    it('should return 404 for non-existent app', async () => {
      const { PATCH } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request('http://localhost:3000/api/external-apps/non-existent', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ displayName: 'New Name' }),
      });

      const response = await PATCH(request, { params: Promise.resolve({ id: 'non-existent' }) });

      expect(response.status).toBe(404);
    });

    it('should validate port range on update', async () => {
      const created = createExternalApp(db, {
        name: 'test-app',
        displayName: 'Test App',
        pathPrefix: 'test',
        targetPort: 3000,
        appType: 'other',
      });

      const { PATCH } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ targetPort: 80 }), // Invalid port
      });

      const response = await PATCH(request, { params: Promise.resolve({ id: created.id }) });

      expect(response.status).toBe(400);
    });
  });

  describe('DELETE /api/external-apps/[id]', () => {
    it('should delete app by ID', async () => {
      const created = createExternalApp(db, {
        name: 'to-delete',
        displayName: 'To Delete',
        pathPrefix: 'delete',
        targetPort: 3000,
        appType: 'other',
      });

      const { DELETE } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}`, {
        method: 'DELETE',
      });

      const response = await DELETE(request, { params: Promise.resolve({ id: created.id }) });

      expect(response.status).toBe(204);
    });

    it('should return 404 for non-existent app', async () => {
      const { DELETE } = await import('@/app/api/external-apps/[id]/route');

      const request = new Request('http://localhost:3000/api/external-apps/non-existent', {
        method: 'DELETE',
      });

      const response = await DELETE(request, { params: Promise.resolve({ id: 'non-existent' }) });

      expect(response.status).toBe(404);
    });
  });

  describe('GET /api/external-apps/[id]/health', () => {
    it('should return health status for app', async () => {
      const created = createExternalApp(db, {
        name: 'health-test',
        displayName: 'Health Test',
        pathPrefix: 'health',
        targetPort: 3000,
        appType: 'nextjs',
      });

      const { GET } = await import('@/app/api/external-apps/[id]/health/route');

      // Mock fetch to simulate port check
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}/health`);
      const response = await GET(request, { params: Promise.resolve({ id: created.id }) });

      expect(response.status).toBe(200);

      const data = await response.json();
      expect(data.health).toHaveProperty('id', created.id);
      expect(data.health).toHaveProperty('healthy');
      expect(data.health).toHaveProperty('lastChecked');
    });

    it('should return healthy: true when port is reachable', async () => {
      const created = createExternalApp(db, {
        name: 'healthy-app',
        displayName: 'Healthy App',
        pathPrefix: 'healthy',
        targetPort: 3001,
        appType: 'nextjs',
      });

      const { GET } = await import('@/app/api/external-apps/[id]/health/route');

      // Mock fetch to simulate successful connection
      global.fetch = vi.fn().mockResolvedValue(new Response('OK', { status: 200 }));

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}/health`);
      const response = await GET(request, { params: Promise.resolve({ id: created.id }) });

      const data = await response.json();
      expect(data.health.healthy).toBe(true);
      expect(data.health.responseTime).toBeGreaterThanOrEqual(0);
    });

    it('should return healthy: false when port is unreachable', async () => {
      const created = createExternalApp(db, {
        name: 'unhealthy-app',
        displayName: 'Unhealthy App',
        pathPrefix: 'unhealthy',
        targetPort: 9999,
        appType: 'other',
      });

      const { GET } = await import('@/app/api/external-apps/[id]/health/route');

      // Mock fetch to simulate connection failure
      global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));

      const request = new Request(`http://localhost:3000/api/external-apps/${created.id}/health`);
      const response = await GET(request, { params: Promise.resolve({ id: created.id }) });

      const data = await response.json();
      expect(data.health.healthy).toBe(false);
      expect(data.health.error).toBeDefined();
    });

    it('should return 404 for non-existent app', async () => {
      const { GET } = await import('@/app/api/external-apps/[id]/health/route');

      const request = new Request('http://localhost:3000/api/external-apps/non-existent/health');
      const response = await GET(request, { params: Promise.resolve({ id: 'non-existent' }) });

      expect(response.status).toBe(404);
    });
  });
});
