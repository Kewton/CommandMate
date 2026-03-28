/**
 * API Integration Tests for /api/worktrees/:id/viewed (Issue #31 - G4)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PATCH as patchViewed } from '@/app/api/worktrees/[id]/viewed/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import { upsertWorktree, getWorktreeById } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Declare mock function type
declare module '@/lib/db/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

// Mock the database instance
vi.mock('@/lib/db/db-instance', () => {
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

describe('PATCH /api/worktrees/:id/viewed (G4)', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should update last_viewed_at timestamp for existing worktree', async () => {
    // Create a worktree
    const worktree: Worktree = {
      id: 'test-worktree',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'repo',
    };
    upsertWorktree(db, worktree);

    // Call the API
    const request = new Request('http://localhost:3000/api/worktrees/test-worktree/viewed', {
      method: 'PATCH',
    });
    const params = { params: { id: 'test-worktree' } };
    const response = await patchViewed(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.success).toBe(true);

    // Verify the update in the database
    const updated = getWorktreeById(db, 'test-worktree');
    expect(updated?.lastViewedAt).toBeDefined();
    expect(updated?.lastViewedAt).toBeInstanceOf(Date);
  });

  it('should return 404 for non-existent worktree (MF1)', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent/viewed', {
      method: 'PATCH',
    });
    const params = { params: { id: 'nonexistent' } };
    const response = await patchViewed(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('should return 500 on database error', async () => {
    // Close database to simulate error
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test/viewed', {
      method: 'PATCH',
    });
    const params = { params: { id: 'test' } };
    const response = await patchViewed(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
