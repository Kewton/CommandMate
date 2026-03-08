/**
 * Unit tests for GET /api/worktrees/:id/git/show/:commitHash
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

vi.mock('@/lib/auto-yes-manager', () => ({
  isValidWorktreeId: vi.fn(),
}));

vi.mock('@/lib/git-utils', async () => {
  const { NextResponse } = await import('next/server');

  class GitTimeoutError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitTimeoutError'; }
  }
  class GitNotRepoError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitNotRepoError'; }
  }

  return {
    getGitShow: vi.fn(),
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

import { GET } from '@/app/api/worktrees/[id]/git/show/[commitHash]/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';
import { getGitShow, GitTimeoutError, GitNotRepoError } from '@/lib/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/worktrees/:id/git/show/:commitHash', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (getGitShow as ReturnType<typeof vi.fn>).mockResolvedValue(null);
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/invalid/git/show/abc1234'),
      { params: { id: 'invalid', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree ID format');
  });

  it('should return 400 for invalid commit hash (too short)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc'),
      { params: { id: 'test-id', commitHash: 'abc' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid commit hash format');
  });

  it('should return 400 for invalid commit hash (uppercase)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/ABC1234'),
      { params: { id: 'test-id', commitHash: 'ABC1234' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid commit hash format');
  });

  it('should return 400 for invalid commit hash (special chars)', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc123!'),
      { params: { id: 'test-id', commitHash: 'abc123!' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid commit hash format');
  });

  it('should accept valid 7-char commit hash', async () => {
    const mockResult = {
      commit: { hash: 'abc1234', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
      files: [],
    };
    (getGitShow as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(200);
  });

  it('should accept valid 40-char commit hash', async () => {
    const hash = 'a'.repeat(40);
    const mockResult = {
      commit: { hash, shortHash: 'aaaaaaa', message: 'test', author: 'a', date: '2026-01-01' },
      files: [],
    };
    (getGitShow as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const response = await GET(
      createRequest(`/api/worktrees/test-id/git/show/${hash}`),
      { params: { id: 'test-id', commitHash: hash } }
    );

    expect(response.status).toBe(200);
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 404 when commit not found', async () => {
    (getGitShow as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Commit not found');
  });

  it('should return 200 with commit details', async () => {
    const mockResult = {
      commit: { hash: 'full', shortHash: 'abc1234', message: 'test', author: 'a', date: '2026-01-01' },
      files: [{ path: 'src/file.ts', status: 'modified' }],
    };
    (getGitShow as ReturnType<typeof vi.fn>).mockResolvedValue(mockResult);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.commit.shortHash).toBe('abc1234');
    expect(data.files).toHaveLength(1);
  });

  it('should return 400 for not a git repository', async () => {
    (getGitShow as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNotRepoError('Not a git repo'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(400);
  });

  it('should return 504 on timeout', async () => {
    (getGitShow as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(504);
  });

  it('should return 500 on general error', async () => {
    (getGitShow as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unknown'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/show/abc1234'),
      { params: { id: 'test-id', commitHash: 'abc1234' } }
    );

    expect(response.status).toBe(500);
  });
});
