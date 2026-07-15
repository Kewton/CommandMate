/**
 * Unit tests for GET /api/worktrees/:id/git/status
 * Issue #779: git status API + GitPane Current Status (Phase 1/5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

// Mock dependencies
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
  getInitialBranch: vi.fn(),
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
    getGitStatus: vi.fn(),
    getAheadBehind: vi.fn(),
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

import { GET } from '@/app/api/worktrees/[id]/git/status/route';
import { getWorktreeById, getInitialBranch } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getGitStatus, getAheadBehind, GitTimeoutError } from '@/lib/git/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

const BASE_STATUS = {
  currentBranch: 'feature/test',
  initialBranch: 'main',
  isBranchMismatch: true,
  commitHash: 'abc1234',
  isDirty: true,
};

describe('GET /api/worktrees/:id/git/status', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (getInitialBranch as ReturnType<typeof vi.fn>).mockReturnValue('main');
    (getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue(BASE_STATUS);
    (getAheadBehind as ReturnType<typeof vi.fn>).mockResolvedValue({ ahead: 2, behind: 1 });
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/invalid!id/git/status'),
      { params: Promise.resolve({ id: 'invalid!id' }) }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree ID format');
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 200 with merged status + aheadBehind', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual({
      ...BASE_STATUS,
      aheadBehind: { ahead: 2, behind: 1 },
    });
  });

  it('should pass worktree.path and initialBranch to getGitStatus', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(getGitStatus).toHaveBeenCalledWith('/path/to/worktree', 'main');
    expect(getAheadBehind).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('should return 200 with aheadBehind=null when getAheadBehind returns null', async () => {
    (getAheadBehind as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.aheadBehind).toBeNull();
    expect(data.currentBranch).toBe('feature/test');
  });

  it('should return 504 on timeout (GitTimeoutError)', async () => {
    (getGitStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(response.status).toBe(504);
    const data = await response.json();
    expect(data.error).toBe('Git command timed out');
  });

  it('should return 500 on general error', async () => {
    (getGitStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('general error'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/status'),
      { params: Promise.resolve({ id: 'test-id' }) }
    );

    expect(response.status).toBe(500);
    const data = await response.json();
    expect(data.error).toBe('Failed to execute git command');
  });
});
