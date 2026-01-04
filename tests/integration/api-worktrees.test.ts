/**
 * API Routes Integration Tests - Worktrees
 * TDD Approach: Red (test first) -> Green (implement) -> Refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { GET as getWorktrees } from '@/app/api/worktrees/route';
import { GET as getWorktreeById } from '@/app/api/worktrees/[id]/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, createMessage } from '@/lib/db';
import type { Worktree } from '@/types/models';

// Declare mock function type
declare module '@/lib/db-instance' {
  export function setMockDb(db: Database.Database): void;
}

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

describe('GET /api/worktrees', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return empty array when no worktrees exist', async () => {
    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data).toEqual({ worktrees: [], repositories: [] });
  });

  it('should return all worktrees sorted by updatedAt DESC', async () => {
    // Insert test worktrees
    const worktree1: Worktree = {
      id: 'main',
      name: 'main',
      path: '/path/to/main',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      updatedAt: new Date('2025-01-17T10:00:00Z'),
    };

    const worktree2: Worktree = {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      updatedAt: new Date('2025-01-17T11:00:00Z'),
    };

    upsertWorktree(db, worktree1);
    upsertWorktree(db, worktree2);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.worktrees).toHaveLength(2);

    // Should be sorted by updatedAt DESC (newest first)
    expect(data.worktrees[0].id).toBe('feature-foo');
    expect(data.worktrees[1].id).toBe('main');
  });

  it('should include lastMessageSummary in response', async () => {
    const worktree: Worktree = {
      id: 'test',
      name: 'test',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      lastMessageSummary: 'Last message summary',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    const data = await response.json();
    expect(data.worktrees[0].lastMessageSummary).toBe('Last message summary');
  });

  it('should return 500 on database error', async () => {
    // Close database to simulate error
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees');
    const response = await getWorktrees(request as unknown as import('next/server').NextRequest);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});

describe('GET /api/worktrees/:id', () => {
  let db: Database.Database;

  beforeEach(async () => {
    db = new Database(':memory:');
    runMigrations(db);

    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should return worktree by id', async () => {
    const worktree: Worktree = {
      id: 'feature-foo',
      name: 'feature/foo',
      path: '/path/to/feature-foo',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
    };

    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/feature-foo');
    const params = { params: { id: 'feature-foo' } };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.id).toBe('feature-foo');
    expect(data.name).toBe('feature/foo');
    expect(data.path).toBe('/path/to/feature-foo');
  });

  it('should return 404 when worktree not found', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/nonexistent');
    const params = { params: { id: 'nonexistent' } };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data).toHaveProperty('error');
    expect(data.error).toContain('not found');
  });

  it('should return 500 on database error', async () => {
    db.close();

    const request = new Request('http://localhost:3000/api/worktrees/test');
    const params = { params: { id: 'test' } };
    const response = await getWorktreeById(request as unknown as import('next/server').NextRequest, params);

    expect(response.status).toBe(500);

    const data = await response.json();
    expect(data).toHaveProperty('error');
  });
});
