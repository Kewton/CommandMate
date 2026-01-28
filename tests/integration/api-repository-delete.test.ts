/**
 * API repository delete integration tests
 * Issue #69: Repository delete feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { DELETE } from '@/app/api/repositories/route';
import { runMigrations } from '@/lib/db-migrations';
import { upsertWorktree, createMessage, getWorktrees } from '@/lib/db';

// Mock db-instance to use test database
let testDb: Database.Database;

vi.mock('@/lib/db-instance', () => ({
  getDbInstance: () => testDb,
}));

// Mock session cleanup
vi.mock('@/lib/session-cleanup', () => ({
  cleanupMultipleWorktrees: vi.fn().mockResolvedValue({
    results: [],
    warnings: [],
  }),
}));

// Mock ws-server
vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  broadcastMessage: vi.fn(),
  cleanupRooms: vi.fn(),
}));

describe('DELETE /api/repositories', () => {
  beforeEach(() => {
    // Create in-memory database for testing
    testDb = new Database(':memory:');
    runMigrations(testDb);

    vi.clearAllMocks();
  });

  afterEach(() => {
    testDb.close();
  });

  it('should return 400 if repositoryPath is missing', async () => {
    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({}),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.success).toBe(false);
    expect(data.error).toContain('repositoryPath');
  });

  it('should return 404 if repository has no worktrees', async () => {
    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: '/non/existent/repo' }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(404);
    expect(data.success).toBe(false);
    expect(data.error).toContain('not found');
  });

  it('should delete all worktrees for the repository', async () => {
    const repoPath = '/path/to/repo';

    // Setup test data
    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });
    upsertWorktree(testDb, {
      id: 'wt-2',
      name: 'feature',
      path: '/path/to/repo/feature',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.deletedWorktreeCount).toBe(2);
    expect(data.deletedWorktreeIds).toHaveLength(2);

    // Verify worktrees are deleted
    const remaining = getWorktrees(testDb);
    expect(remaining).toHaveLength(0);
  });

  it('should not delete worktrees from other repositories', async () => {
    const repoPath1 = '/path/to/repo1';
    const repoPath2 = '/path/to/repo2';

    upsertWorktree(testDb, {
      id: 'wt-repo1',
      name: 'main',
      path: '/path/to/repo1/main',
      repositoryPath: repoPath1,
      repositoryName: 'repo1',
    });
    upsertWorktree(testDb, {
      id: 'wt-repo2',
      name: 'main',
      path: '/path/to/repo2/main',
      repositoryPath: repoPath2,
      repositoryName: 'repo2',
    });

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath1 }),
    });

    await DELETE(request);

    // repo2 worktree should still exist
    const remaining = getWorktrees(testDb);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe('wt-repo2');
  });

  it('should call session cleanup for all worktrees', async () => {
    const repoPath = '/path/to/repo';

    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    const { cleanupMultipleWorktrees } = await import('@/lib/session-cleanup');

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    await DELETE(request);

    expect(cleanupMultipleWorktrees).toHaveBeenCalledWith(
      ['wt-1'],
      expect.any(Function)
    );
  });

  it('should call cleanupRooms with worktree IDs', async () => {
    const repoPath = '/path/to/repo';

    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    const { cleanupRooms } = await import('@/lib/ws-server');

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    await DELETE(request);

    expect(cleanupRooms).toHaveBeenCalledWith(['wt-1']);
  });

  it('should broadcast repository_deleted message', async () => {
    const repoPath = '/path/to/repo';

    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    const { broadcastMessage } = await import('@/lib/ws-server');

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    await DELETE(request);

    expect(broadcastMessage).toHaveBeenCalledWith(
      'repository_deleted',
      expect.objectContaining({
        repositoryPath: repoPath,
        deletedWorktreeIds: ['wt-1'],
      })
    );
  });

  it('should include warnings in response when cleanup has errors', async () => {
    const repoPath = '/path/to/repo';

    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    const { cleanupMultipleWorktrees } = await import('@/lib/session-cleanup');
    vi.mocked(cleanupMultipleWorktrees).mockResolvedValueOnce({
      results: [],
      warnings: ['Session kill failed for claude', 'Poller stop failed'],
    });

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    const response = await DELETE(request);
    const data = await response.json();

    expect(response.status).toBe(200);
    expect(data.success).toBe(true);
    expect(data.warnings).toHaveLength(2);
  });

  it('should cascade delete chat messages', async () => {
    const repoPath = '/path/to/repo';

    upsertWorktree(testDb, {
      id: 'wt-1',
      name: 'main',
      path: '/path/to/repo/main',
      repositoryPath: repoPath,
      repositoryName: 'repo',
    });

    createMessage(testDb, {
      worktreeId: 'wt-1',
      role: 'user',
      content: 'Test message',
      messageType: 'normal',
      timestamp: new Date(),
    });

    const request = new NextRequest('http://localhost:3000/api/repositories', {
      method: 'DELETE',
      body: JSON.stringify({ repositoryPath: repoPath }),
    });

    await DELETE(request);

    // Verify chat messages are deleted
    const messages = testDb.prepare(
      'SELECT * FROM chat_messages WHERE worktree_id = ?'
    ).all('wt-1');
    expect(messages).toHaveLength(0);
  });
});
