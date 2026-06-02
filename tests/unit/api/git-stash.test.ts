/**
 * Unit tests for GET /api/worktrees/:id/git/stash
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
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
  class GitTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'GitTimeoutError'; } }
  class GitNotRepoError extends Error { constructor(m: string) { super(m); this.name = 'GitNotRepoError'; } }
  return {
    getStashList: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'timeout' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    },
  };
});

import { GET } from '@/app/api/worktrees/[id]/git/stash/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { getStashList } from '@/lib/git/git-utils';

function createRequest(): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/stash', 'http://localhost:3000'));
}

describe('GET /api/worktrees/:id/git/stash (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (getStashList as ReturnType<typeof vi.fn>).mockResolvedValue([]);
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

  it('returns 200 with the stash list on success', async () => {
    const stashes = [{ index: 0, message: 'WIP on main: x', branch: 'main', date: '2026-01-01', sha: 'abc' }];
    (getStashList as ReturnType<typeof vi.fn>).mockResolvedValue(stashes);
    const response = await GET(createRequest(), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.stashes).toEqual(stashes);
    expect(getStashList).toHaveBeenCalledWith('/path/to/worktree');
  });

  it('returns 200 with an empty list (best-effort degrade)', async () => {
    const response = await GET(createRequest(), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.stashes).toEqual([]);
  });
});
