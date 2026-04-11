/**
 * API integration tests: PUT /api/repositories/[id]
 * Issue #644: Regression coverage for displayName update flow.
 *
 * Verifies:
 * - 400 for invalid body / invalid displayName type
 * - 400 for displayName longer than MAX_DISPLAY_NAME_LENGTH (error message
 *   wording is pinned to the historical phrasing per Issue #644 constraints)
 * - 404 for non-existent repository IDs
 * - 200 + DB update on happy path
 * - Empty string and null values clear the displayName
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { PUT } from '@/app/api/repositories/[id]/route';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createRepository,
  getRepositoryById,
} from '@/lib/db/db-repository';
import { MAX_DISPLAY_NAME_LENGTH } from '@/config/repository-config';

let testDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => testDb,
}));

describe('PUT /api/repositories/[id] (Issue #644)', () => {
  beforeEach(() => {
    testDb = new Database(':memory:');
    runMigrations(testDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  /** Helper to build a typed route params object. */
  function buildParams(id: string) {
    return { params: Promise.resolve({ id }) };
  }

  it('returns 400 when displayName is a number', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const request = new NextRequest('http://localhost/api/repositories/' + repo.id, {
      method: 'PUT',
      body: JSON.stringify({ displayName: 123 }),
    });

    const response = await PUT(request, buildParams(repo.id));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('displayName must be a string');
  });

  it(`returns 400 with the historical error message when displayName exceeds ${MAX_DISPLAY_NAME_LENGTH} chars`, async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const tooLong = 'x'.repeat(MAX_DISPLAY_NAME_LENGTH + 1);
    const request = new NextRequest('http://localhost/api/repositories/' + repo.id, {
      method: 'PUT',
      body: JSON.stringify({ displayName: tooLong }),
    });

    const response = await PUT(request, buildParams(repo.id));
    const data = await response.json();

    expect(response.status).toBe(400);
    // Historic phrasing pinned per Issue #644 constraint
    expect(data.error).toBe(
      `displayName must be ${MAX_DISPLAY_NAME_LENGTH} characters or less`
    );
  });

  it('accepts displayName exactly at MAX_DISPLAY_NAME_LENGTH boundary', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const atLimit = 'a'.repeat(MAX_DISPLAY_NAME_LENGTH);
    const request = new NextRequest('http://localhost/api/repositories/' + repo.id, {
      method: 'PUT',
      body: JSON.stringify({ displayName: atLimit }),
    });

    const response = await PUT(request, buildParams(repo.id));
    expect(response.status).toBe(200);

    const stored = getRepositoryById(testDb, repo.id);
    expect(stored!.displayName).toBe(atLimit);
  });

  it('returns 404 when repository id does not exist', async () => {
    const request = new NextRequest('http://localhost/api/repositories/does-not-exist', {
      method: 'PUT',
      body: JSON.stringify({ displayName: 'Alias' }),
    });

    const response = await PUT(request, buildParams('does-not-exist'));
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.error).toBe('Repository not found');
  });

  it('returns 200 and updates displayName on the happy path', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const request = new NextRequest('http://localhost/api/repositories/' + repo.id, {
      method: 'PUT',
      body: JSON.stringify({ displayName: 'My Alias' }),
    });

    const response = await PUT(request, buildParams(repo.id));
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.repository.id).toBe(repo.id);
    expect(data.repository.displayName).toBe('My Alias');

    // DB is updated
    const stored = getRepositoryById(testDb, repo.id);
    expect(stored!.displayName).toBe('My Alias');
  });

  it('clears the displayName when called with empty string', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    // Set, then clear with empty string
    await PUT(
      new NextRequest('http://localhost/api/repositories/' + repo.id, {
        method: 'PUT',
        body: JSON.stringify({ displayName: 'Initial' }),
      }),
      buildParams(repo.id)
    );

    const clearResponse = await PUT(
      new NextRequest('http://localhost/api/repositories/' + repo.id, {
        method: 'PUT',
        body: JSON.stringify({ displayName: '' }),
      }),
      buildParams(repo.id)
    );
    const clearData = await clearResponse.json();

    expect(clearResponse.status).toBe(200);
    expect(clearData.repository.displayName).toBeNull();

    const stored = getRepositoryById(testDb, repo.id);
    expect(stored!.displayName).toBeUndefined();
  });

  it('clears the displayName when called with null', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    await PUT(
      new NextRequest('http://localhost/api/repositories/' + repo.id, {
        method: 'PUT',
        body: JSON.stringify({ displayName: 'Initial' }),
      }),
      buildParams(repo.id)
    );

    const response = await PUT(
      new NextRequest('http://localhost/api/repositories/' + repo.id, {
        method: 'PUT',
        body: JSON.stringify({ displayName: null }),
      }),
      buildParams(repo.id)
    );
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.repository.displayName).toBeNull();

    const stored = getRepositoryById(testDb, repo.id);
    expect(stored!.displayName).toBeUndefined();
  });

  it('returns 400 when request body is missing', async () => {
    const repo = createRepository(testDb, {
      name: 'repo-a',
      path: '/path/to/repo-a',
      cloneSource: 'local',
    });

    const request = new NextRequest('http://localhost/api/repositories/' + repo.id, {
      method: 'PUT',
      body: JSON.stringify(null),
    });

    const response = await PUT(request, buildParams(repo.id));
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe('Request body is required');
  });
});
