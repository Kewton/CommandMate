/**
 * Unit tests for GET /api/worktrees/:id/git/working-diff
 * Issue #780: per-file working-tree diff (staged / unstaged / untracked)
 *
 * Mirrors git-staged.test.ts / git-diff.test.ts patterns.
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
  isPathSafe: vi.fn(),
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
    getWorkingTreeDiff: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitNotRepoError) {
        return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'Git command timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed to execute git command' }, { status: 500 });
    },
  };
});

import { GET } from '@/app/api/worktrees/[id]/git/working-diff/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId, isPathSafe } from '@/lib/security/path-validator';
import { getWorkingTreeDiff, GitTimeoutError, GitNotRepoError } from '@/lib/git/git-utils';

function createRequest(url: string): NextRequest {
  return new NextRequest(new URL(url, 'http://localhost:3000'));
}

describe('GET /api/worktrees/:id/git/working-diff (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue('diff output');
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/bad!/git/working-diff?file=a.ts&mode=unstaged'),
      { params: { id: 'bad!' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid worktree ID format');
  });

  it('should return 400 for missing file path', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid file path');
  });

  it('should return 400 for an invalid mode', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=a.ts&mode=bogus'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid mode');
  });

  it('should return 400 for an unsafe file path', async () => {
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(false);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=../../etc/passwd&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.error).toBe('Invalid file path');
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.error).toBe('Worktree not found');
  });

  it('should return 200 with the diff content', async () => {
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue('diff --git a/a.ts b/a.ts');

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.diff).toBe('diff --git a/a.ts b/a.ts');
    expect(getWorkingTreeDiff).toHaveBeenCalledWith('/path/to/worktree', 'src/a.ts', 'unstaged');
  });

  it('should default to unstaged mode when mode is omitted', async () => {
    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/a.ts'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(200);
    expect(getWorkingTreeDiff).toHaveBeenCalledWith('/path/to/worktree', 'src/a.ts', 'unstaged');
  });

  it('should pass the staged mode through to getWorkingTreeDiff', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/a.ts&mode=staged'),
      { params: { id: 'test-id' } }
    );

    expect(getWorkingTreeDiff).toHaveBeenCalledWith('/path/to/worktree', 'src/a.ts', 'staged');
  });

  it('should pass the untracked mode through to getWorkingTreeDiff', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/new.ts&mode=untracked'),
      { params: { id: 'test-id' } }
    );

    expect(getWorkingTreeDiff).toHaveBeenCalledWith('/path/to/worktree', 'src/new.ts', 'untracked');
  });

  it('should return 200 with an empty diff when the file is clean (null)', async () => {
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/clean.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.diff).toBe('');
  });

  it('should call isPathSafe with the file path and worktree path', async () => {
    await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=src/a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(isPathSafe).toHaveBeenCalledWith('src/a.ts', '/path/to/worktree');
  });

  it('should return 400 for not a git repository', async () => {
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNotRepoError('Not a git repo'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(400);
  });

  it('should return 504 on timeout', async () => {
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timed out'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(504);
  });

  it('should return 500 on a general error', async () => {
    (getWorkingTreeDiff as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));

    const response = await GET(
      createRequest('/api/worktrees/test-id/git/working-diff?file=a.ts&mode=unstaged'),
      { params: { id: 'test-id' } }
    );

    expect(response.status).toBe(500);
  });
});
