/**
 * Unit tests for GET /api/worktrees/:id/git/diff
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

vi.mock('@/lib/path-validator', () => ({
  isPathSafe: vi.fn(),
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
    getGitDiff: vi.fn(),
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

import { GET } from '@/app/api/worktrees/[id]/git/diff/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/auto-yes-manager';
import { isPathSafe } from '@/lib/path-validator';
import { getGitDiff, GitTimeoutError, GitNotRepoError } from '@/lib/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/worktrees/:id/git/diff', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getGitDiff as ReturnType<typeof vi.fn>).mockResolvedValue('diff output');
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/invalid/git/diff?commit=abc1234&file=test.ts'),
      { params: { id: 'invalid' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree ID format');
  });

  it('should return 400 for missing commit hash', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid commit hash format');
  });

  it('should return 400 for invalid commit hash', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=INVALID&file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid commit hash format');
  });

  it('should return 400 for missing file path', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid file path');
  });

  it('should return 400 for unsafe file path', async () => {
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=../../etc/passwd'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid file path');
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 200 with diff content', async () => {
    (getGitDiff as ReturnType<typeof vi.fn>).mockResolvedValue('diff --git a/file.ts b/file.ts');

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=src/file.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.diff).toBe('diff --git a/file.ts b/file.ts');
  });

  it('should call isPathSafe with file path and worktree path', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=src/file.ts'),
      { params: { id: 'test-id' } }
    );

    expect(isPathSafe).toHaveBeenCalledWith('src/file.ts', '/path/to/worktree');
  });

  it('should return 404 when diff is null', async () => {
    (getGitDiff as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=nonexistent.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(404);
  });

  it('should return 400 for not a git repository', async () => {
    (getGitDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNotRepoError('Not a git repo'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
  });

  it('should return 504 on timeout', async () => {
    (getGitDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(504);
  });

  it('should return 500 on general error', async () => {
    (getGitDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('unknown'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/diff?commit=abc1234&file=test.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(500);
  });
});
