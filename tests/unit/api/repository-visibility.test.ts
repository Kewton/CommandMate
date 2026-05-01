/**
 * Unit tests for Repository visibility API (Issue #690)
 *
 * Covers:
 * - GET /api/repositories returns `visible` for each repository row
 * - PUT /api/repositories/[id] accepts `visible` (boolean) for partial update
 * - PUT rejects non-boolean `visible` and the empty body case
 * - PUT preserves `enabled` when only `visible` changes (independence)
 * - PUT 404 for unknown repository IDs
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createRepository,
  getRepositoryById,
} from '@/lib/db/db-repository';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

// The GET route uses the logger; mock it to avoid the logger Node-only path.
vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { GET } from '@/app/api/repositories/route';
import { PUT } from '@/app/api/repositories/[id]/route';

function buildPutRequest(id: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost/api/repositories/${id}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

function buildParams(id: string) {
  return { params: Promise.resolve({ id }) };
}

describe('Repository visibility API (Issue #690)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  describe('GET /api/repositories', () => {
    it('includes `visible: true` for repositories created with the default', async () => {
      createRepository(testDb, {
        name: 'repo-vis',
        path: '/path/to/repo-vis',
        cloneSource: 'local',
      });

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(Array.isArray(data.repositories)).toBe(true);
      expect(data.repositories).toHaveLength(1);
      expect(data.repositories[0].visible).toBe(true);
      // Sanity: enabled is independent
      expect(data.repositories[0].enabled).toBe(true);
    });

    it('reflects `visible: false` when explicitly persisted', async () => {
      createRepository(testDb, {
        name: 'hidden-repo',
        path: '/path/to/hidden-repo',
        cloneSource: 'local',
        visible: false,
      });

      const response = await GET();
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.repositories[0].visible).toBe(false);
    });
  });

  describe('PUT /api/repositories/[id] visible field', () => {
    it('updates visible from true to false', async () => {
      const repo = createRepository(testDb, {
        name: 'repo-toggle',
        path: '/path/to/repo-toggle',
        cloneSource: 'local',
      });
      expect(repo.visible).toBe(true);

      const response = await PUT(
        buildPutRequest(repo.id, { visible: false }),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.repository.visible).toBe(false);

      // DB-level confirmation
      const stored = getRepositoryById(testDb, repo.id);
      expect(stored?.visible).toBe(false);
    });

    it('updates visible from false to true', async () => {
      const repo = createRepository(testDb, {
        name: 'hidden-toggle',
        path: '/path/to/hidden-toggle',
        cloneSource: 'local',
        visible: false,
      });

      const response = await PUT(
        buildPutRequest(repo.id, { visible: true }),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.repository.visible).toBe(true);
    });

    it('preserves enabled when only visible changes (independence)', async () => {
      const repo = createRepository(testDb, {
        name: 'enabled-vis-indep',
        path: '/path/to/enabled-vis-indep',
        cloneSource: 'local',
        enabled: false,
        visible: true,
      });

      const response = await PUT(
        buildPutRequest(repo.id, { visible: false }),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.repository.enabled).toBe(false);
      expect(data.repository.visible).toBe(false);
    });

    it('rejects non-boolean visible with 400', async () => {
      const repo = createRepository(testDb, {
        name: 'repo-bad-visible',
        path: '/path/to/repo-bad-visible',
        cloneSource: 'local',
      });

      const response = await PUT(
        buildPutRequest(repo.id, { visible: 'yes' }),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('visible must be a boolean');
    });

    it('returns 400 when body has neither displayName nor visible', async () => {
      const repo = createRepository(testDb, {
        name: 'repo-empty-body',
        path: '/path/to/repo-empty-body',
        cloneSource: 'local',
      });

      const response = await PUT(
        buildPutRequest(repo.id, {}),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.error).toBe('displayName or visible is required');
    });

    it('returns 404 when repository ID does not exist', async () => {
      const response = await PUT(
        buildPutRequest('non-existent-id', { visible: true }),
        buildParams('non-existent-id')
      );
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.error).toBe('Repository not found');
    });

    it('supports updating displayName and visible together', async () => {
      const repo = createRepository(testDb, {
        name: 'repo-multi',
        path: '/path/to/repo-multi',
        cloneSource: 'local',
      });

      const response = await PUT(
        buildPutRequest(repo.id, { displayName: 'Alias', visible: false }),
        buildParams(repo.id)
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.repository.displayName).toBe('Alias');
      expect(data.repository.visible).toBe(false);
    });
  });
});
