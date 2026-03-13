/**
 * Unit tests for GET /api/worktrees/:id/git/log
 * Issue #447: Git tab feature
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
}));

vi.mock('@/lib/security/path-validator', () => ({
  isValidWorktreeId: vi.fn(),
}));

vi.mock('@/lib/git/git-utils', async () => {
  const { NextResponse } = await import('next/server');

  class GitTimeoutError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitTimeoutError'; }
  }
  class GitNotRepoError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitNotRepoError'; }
  }

  return {
    getGitLog: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    handleGitApiError: (error: unknown, logPrefix: string) => {
      if (error instanceof GitNotRepoError) {
        return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'Git command timed out' }, { status: 504 });
      }
      console.error(`[${logPrefix}] Error:`, error);
      return NextResponse.json({ error: 'Failed to execute git command' }, { status: 500 });
    },
  };
});

import { GET } from '@/app/api/worktrees/[id]/git/log/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getGitLog, GitTimeoutError, GitNotRepoError } from '@/lib/git/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/worktrees/:id/git/log', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (getGitLog as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/invalid!id/git/log'),
      { params: { id: 'invalid!id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree ID format');
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 200 with commits', async () => {
    const mockCommits = [
      { hash: 'abc', shortHash: 'abc', message: 'test', author: 'author', date: '2026-01-01' },
    ];
    (getGitLog as ReturnType<typeof vi.fn>).mockResolvedValue(mockCommits);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.commits).toEqual(mockCommits);
  });

  it('should pass default limit=50 and offset=0', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(getGitLog).toHaveBeenCalledWith('/path/to/worktree', 50, 0);
  });

  it('should pass custom limit and offset', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/log?limit=10&offset=5'),
      { params: { id: 'test-id' } }
    );

    expect(getGitLog).toHaveBeenCalledWith('/path/to/worktree', 10, 5);
  });

  it('should return 400 for invalid limit (0)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log?limit=0'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid limit parameter');
  });

  it('should return 400 for invalid limit (101)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log?limit=101'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid limit parameter');
  });

  it('should return 400 for invalid limit (NaN)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log?limit=abc'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid limit parameter');
  });

  it('should return 400 for invalid offset (negative)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log?offset=-1'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid offset parameter');
  });

  it('should return 400 for invalid offset (NaN)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log?offset=xyz'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid offset parameter');
  });

  it('should return 400 for not a git repository', async () => {
    (getGitLog as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNotRepoError('Not a git repository'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Not a git repository');
  });

  it('should return 504 on timeout', async () => {
    (getGitLog as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(504);
    const data = await response.json();
    expect(data.error).toBe('Git command timed out');
  });

  it('should return 500 on general error', async () => {
    (getGitLog as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('general error'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/log'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Failed to execute git command');
  });
});
