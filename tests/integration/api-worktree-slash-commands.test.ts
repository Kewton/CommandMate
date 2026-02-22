/**
 * Integration tests for worktree-specific slash commands API (Issue #56)
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock the database functions
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({})),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

describe('GET /api/worktrees/[id]/slash-commands', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should return 404 when worktree is not found', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue(null);

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/non-existent/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'non-existent' }) });

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 400 for invalid worktree path', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'test-id',
      name: 'test',
      path: '../../../etc/passwd', // Invalid path
      repositoryPath: '/test',
      repositoryName: 'test',
      cliToolId: 'claude',
    });

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree configuration');
  });

  it('should return merged command groups for valid worktree', async () => {
    const { getWorktreeById } = await import('@/lib/db');
    vi.mocked(getWorktreeById).mockReturnValue({
      id: 'test-id',
      name: 'test',
      path: '/Users/test/projects/my-project',
      repositoryPath: '/Users/test/projects/my-project',
      repositoryName: 'my-project',
      cliToolId: 'claude',
    });

    const { GET } = await import(
      '@/app/api/worktrees/[id]/slash-commands/route'
    );

    const request = new NextRequest('http://localhost:3000/api/worktrees/test-id/slash-commands');
    const response = await GET(request, { params: Promise.resolve({ id: 'test-id' }) });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toHaveProperty('groups');
    expect(data).toHaveProperty('sources');
    expect(Array.isArray(data.groups)).toBe(true);
    // Should include standard commands even if no worktree-specific commands
    expect(data.sources.standard).toBeGreaterThan(0);
    // Issue #343: sources should include skill property
    expect(data.sources).toHaveProperty('skill');
    expect(typeof data.sources.skill).toBe('number');
  });
});
