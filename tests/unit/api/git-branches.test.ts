/**
 * Unit tests for GET /api/worktrees/:id/git/branches
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
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

  return {
    listBranches: vi.fn(),
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

import { GET } from '@/app/api/worktrees/[id]/git/branches/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { listBranches } from '@/lib/git/git-utils';

const BRANCHES = [
  {
    name: 'main',
    isCurrent: true,
    isRemote: false,
    isDefault: true,
    upstream: 'origin/main',
    aheadBehind: { ahead: 0, behind: 0 },
    checkedOutWorktreePath: '/repo',
  },
];

function createRequest(query = ''): NextRequest {
  return new NextRequest(
    new URL(`/api/worktrees/test-id/git/branches${query}`, 'http://localhost:3000')
  );
}

describe('GET /api/worktrees/:id/git/branches (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (listBranches as ReturnType<typeof vi.fn>).mockResolvedValue(BRANCHES);
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await GET(createRequest(), { params: { id: 'bad!' } });
    expect(response.status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await GET(createRequest(), { params: { id: 'test-id' } });
    expect(response.status).toBe(404);
  });

  it('returns 200 with the branches and defaults include to local', async () => {
    const response = await GET(createRequest(), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.branches).toEqual(BRANCHES);
    expect(listBranches).toHaveBeenCalledWith('/path/to/worktree', 'local');
  });

  it('passes include=remote through', async () => {
    await GET(createRequest('?include=remote'), { params: { id: 'test-id' } });
    expect(listBranches).toHaveBeenCalledWith('/path/to/worktree', 'remote');
  });

  it('passes include=all through', async () => {
    await GET(createRequest('?include=all'), { params: { id: 'test-id' } });
    expect(listBranches).toHaveBeenCalledWith('/path/to/worktree', 'all');
  });

  it('falls back to local for an invalid include value', async () => {
    await GET(createRequest('?include=bogus'), { params: { id: 'test-id' } });
    expect(listBranches).toHaveBeenCalledWith('/path/to/worktree', 'local');
  });
});
