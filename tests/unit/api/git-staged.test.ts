/**
 * Unit tests for GET /api/worktrees/:id/git/staged
 * Issue #780: stage/unstage/commit operations (Phase 2/5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({
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
  class GitIndexLockedError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitIndexLockedError'; }
  }

  return {
    getStagedStatus: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitNotRepoError) {
        return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
      }
      if (error instanceof GitIndexLockedError) {
        return NextResponse.json({ error: 'Git index is locked by another operation' }, { status: 409 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'Git command timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed to execute git command' }, { status: 500 });
    },
  };
});

import { GET } from '@/app/api/worktrees/[id]/git/staged/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getStagedStatus, GitTimeoutError } from '@/lib/git/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

const STAGED = {
  staged: [{ path: 'a.ts', status: 'modified' }],
  unstaged: [{ path: 'b.ts', status: 'modified' }],
  untracked: [{ path: 'c.ts', status: 'untracked' }],
};

describe('GET /api/worktrees/:id/git/staged (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (getStagedStatus as ReturnType<typeof vi.fn>).mockResolvedValue(STAGED);
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(createRequest('/api/worktrees/bad!/git/staged'), { params: { id: 'bad!' } });

    expect(response.status).toBe(400);
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(createRequest('/api/worktrees/test-id/git/staged'), { params: { id: 'test-id' } });

    expect(response.status).toBe(404);
  });

  it('should return 200 with the staged buckets', async () => {
    const response = await GET(createRequest('/api/worktrees/test-id/git/staged'), { params: { id: 'test-id' } });

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data).toEqual(STAGED);
    expect(getStagedStatus).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('should return 504 on timeout', async () => {
    (getStagedStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(createRequest('/api/worktrees/test-id/git/staged'), { params: { id: 'test-id' } });

    expect(response.status).toBe(504);
  });

  it('should return 500 on general error', async () => {
    (getStagedStatus as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const response = await GET(createRequest('/api/worktrees/test-id/git/staged'), { params: { id: 'test-id' } });

    expect(response.status).toBe(500);
  });
});
