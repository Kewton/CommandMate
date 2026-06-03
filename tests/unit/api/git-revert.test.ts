/**
 * Unit tests for POST /api/worktrees/:id/git/revert
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
  class GitIndexLockedError extends Error { constructor(m: string) { super(m); this.name = 'GitIndexLockedError'; } }
  return {
    gitRevert: vi.fn(),
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

import { POST } from '@/app/api/worktrees/[id]/git/revert/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitRevert, GitTimeoutError, GitIndexLockedError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/revert', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/revert (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (gitRevert as ReturnType<typeof vi.fn>).mockResolvedValue({ conflict: false });
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({ commitHash: 'abc1234' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(404);
  });

  it('returns 400 invalid_target for a missing commit hash', async () => {
    const response = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_target');
    expect(gitRevert).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_target for an uppercase hash', async () => {
    const response = await POST(createRequest({ commitHash: 'ABCDEF1' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
  });

  it('returns 400 invalid_target for HEAD literal', async () => {
    const response = await POST(createRequest({ commitHash: 'HEAD' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
  });

  it('reverts a valid commit hash and returns 200', async () => {
    const response = await POST(createRequest({ commitHash: 'deadbeef' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    expect(gitRevert).toHaveBeenCalledWith('/path/to/worktree', { commitHash: 'deadbeef', noCommit: false });
  });

  it('forwards noCommit', async () => {
    await POST(createRequest({ commitHash: 'deadbeef', noCommit: true }), { params: { id: 'test-id' } });
    expect(gitRevert).toHaveBeenCalledWith('/path/to/worktree', { commitHash: 'deadbeef', noCommit: true });
  });

  it('returns 200 with conflict info when the revert conflicts', async () => {
    (gitRevert as ReturnType<typeof vi.fn>).mockResolvedValue({ conflict: true, conflictFiles: ['x.ts'] });
    const response = await POST(createRequest({ commitHash: 'deadbeef' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.conflict).toBe(true);
    expect(data.conflictFiles).toEqual(['x.ts']);
  });

  it('returns 409 when the index is locked', async () => {
    (gitRevert as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    const response = await POST(createRequest({ commitHash: 'deadbeef' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(409);
  });

  it('returns 504 on timeout', async () => {
    (gitRevert as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timeout'));
    const response = await POST(createRequest({ commitHash: 'deadbeef' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(504);
  });
});
