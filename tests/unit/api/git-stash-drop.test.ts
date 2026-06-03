/**
 * Unit tests for DELETE /api/worktrees/:id/git/stash/:index
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 *
 * Dynamic segment route: params.index is a STRING validated with validateStashIndex.
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
  class GitIndexLockedError extends Error { constructor(m: string) { super(m); this.name = 'GitIndexLockedError'; } }
  return {
    stashDrop: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitIndexLockedError) {
        return NextResponse.json({ error: 'locked' }, { status: 409 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'timeout' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    },
  };
});

import { DELETE } from '@/app/api/worktrees/[id]/git/stash/[index]/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { stashDrop, GitTimeoutError, GitIndexLockedError } from '@/lib/git/git-utils';

function createRequest(): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/stash/0', 'http://localhost:3000'), {
    method: 'DELETE',
  });
}

describe('DELETE /api/worktrees/:id/git/stash/:index (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (stashDrop as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: '0' } });
    expect(response.status).toBe(404);
  });

  it('drops the stash at the string index and returns 200', async () => {
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: '2' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.dropped).toBe(2);
    expect(stashDrop).toHaveBeenCalledWith('/path/to/worktree', 2);
  });

  it('returns 400 invalid_stash_index for a non-numeric segment', async () => {
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: 'abc' } });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_stash_index');
    expect(stashDrop).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_stash_index for a decimal segment', async () => {
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: '1.5' } });
    expect(response.status).toBe(400);
  });

  it('returns 409 when the index is locked', async () => {
    (stashDrop as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: '0' } });
    expect(response.status).toBe(409);
  });

  it('returns 504 on timeout', async () => {
    (stashDrop as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timeout'));
    const response = await DELETE(createRequest(), { params: { id: 'test-id', index: '0' } });
    expect(response.status).toBe(504);
  });
});
