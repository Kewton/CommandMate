/**
 * API Routes Integration Tests - CLI Tool Update
 * Tests the /api/worktrees/:id/cli-tool endpoint for updating worktree CLI tool
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PATCH as updateCliTool } from '@/app/api/worktrees/[id]/cli-tool/route';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, getWorktreeById } from '@/lib/db';
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

describe('PATCH /api/worktrees/:id/cli-tool', () => {
  let db: Database.Database;

  beforeEach(async () => {
    // Create in-memory database for testing
    db = new Database(':memory:');
    runMigrations(db);

    // Set mock database
    const { setMockDb } = await import('@/lib/db-instance');
    setMockDb(db);

    // Reset mocks
    vi.clearAllMocks();
  });

  afterEach(async () => {
    const { closeDbInstance } = await import('@/lib/db-instance');
    closeDbInstance();
    db.close();
  });

  it('should update worktree CLI tool to codex', async () => {
    // Create test worktree with default claude
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    // Update to codex
    const request = new Request('http://localhost:3000/api/worktrees/test-wt/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId: 'codex' }),
    });

    const response = await updateCliTool(request as unknown as import('next/server').NextRequest, { params: { id: 'test-wt' } });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.cliToolId).toBe('codex');

    // Verify database was updated
    const updated = getWorktreeById(db, 'test-wt');
    expect(updated?.cliToolId).toBe('codex');
  });

  it('should update worktree CLI tool to gemini', async () => {
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/test-wt/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId: 'gemini' }),
    });

    const response = await updateCliTool(request as unknown as import('next/server').NextRequest, { params: { id: 'test-wt' } });
    expect(response.status).toBe(200);

    const data = await response.json();
    expect(data.cliToolId).toBe('gemini');

    // Verify database was updated
    const updated = getWorktreeById(db, 'test-wt');
    expect(updated?.cliToolId).toBe('gemini');
  });

  it('should return 400 for invalid CLI tool ID', async () => {
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/test-wt/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId: 'invalid-tool' }),
    });

    const response = await updateCliTool(request as unknown as import('next/server').NextRequest, { params: { id: 'test-wt' } });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('Invalid CLI tool ID');
  });

  it('should return 404 for non-existent worktree', async () => {
    const request = new Request('http://localhost:3000/api/worktrees/non-existent/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cliToolId: 'codex' }),
    });

    const response = await updateCliTool(request as unknown as import('next/server').NextRequest, { params: { id: 'non-existent' } });
    expect(response.status).toBe(404);

    const data = await response.json();
    expect(data.error).toContain('not found');
  });

  it('should return 400 for missing cliToolId in request body', async () => {
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/test-wt/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const response = await updateCliTool(request as unknown as import('next/server').NextRequest, { params: { id: 'test-wt' } });
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('CLI tool ID is required');
  });

  it('should return 400 when request body is not a JSON object', async () => {
    const worktree: Worktree = {
      id: 'test-wt',
      name: 'Test Worktree',
      path: '/path/to/test',
      repositoryPath: '/path/to/repo',
      repositoryName: 'TestRepo',
      cliToolId: 'claude',
    };
    upsertWorktree(db, worktree);

    const request = new Request('http://localhost:3000/api/worktrees/test-wt/cli-tool', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(['invalid']),
    });

    const response = await updateCliTool(
      request as unknown as import('next/server').NextRequest,
      { params: { id: 'test-wt' } }
    );
    expect(response.status).toBe(400);

    const data = await response.json();
    expect(data.error).toContain('JSON object');
  });
});
