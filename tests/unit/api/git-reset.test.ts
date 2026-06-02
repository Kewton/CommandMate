/**
 * Unit tests for POST /api/worktrees/:id/git/reset
 * Issue #782: stash + reset/revert (Phase 4/5 - Danger Zone)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
  getInitialBranch: vi.fn().mockReturnValue('main'),
}));

vi.mock('@/lib/security/path-validator', () => ({
  isValidWorktreeId: vi.fn(),
}));

vi.mock('@/lib/git/git-utils', async () => {
  const { NextResponse } = await import('next/server');
  class GitTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'GitTimeoutError'; } }
  class GitNotRepoError extends Error { constructor(m: string) { super(m); this.name = 'GitNotRepoError'; } }
  class GitIndexLockedError extends Error { constructor(m: string) { super(m); this.name = 'GitIndexLockedError'; } }
  class GitResetDefaultBranchError extends Error { constructor(m: string) { super(m); this.name = 'GitResetDefaultBranchError'; } }
  return {
    gitReset: vi.fn(),
    getGitStatus: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    GitResetDefaultBranchError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitResetDefaultBranchError) {
        return NextResponse.json({ error: 'default', reason: 'default_branch' }, { status: 409 });
      }
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

import { POST } from '@/app/api/worktrees/[id]/git/reset/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitReset, getGitStatus, GitTimeoutError, GitIndexLockedError, GitResetDefaultBranchError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/reset', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

const STATUS = { currentBranch: 'feature/x', initialBranch: 'main', isBranchMismatch: false, commitHash: 'abc', isDirty: false };

describe('POST /api/worktrees/:id/git/reset (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (gitReset as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue(STATUS);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({ target: 'HEAD', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(404);
  });

  it('returns 400 invalid_mode for a bad mode', async () => {
    const response = await POST(createRequest({ target: 'HEAD', mode: 'bogus' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    expect(gitReset).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_target for a branch-name target', async () => {
    const response = await POST(createRequest({ target: 'main', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_target');
    expect(gitReset).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_target for HEAD~1', async () => {
    const response = await POST(createRequest({ target: 'HEAD~1', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
  });

  it('returns 400 invalid_target for an uppercase hash', async () => {
    const response = await POST(createRequest({ target: 'ABC1234', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
  });

  it('accepts the literal HEAD target (soft)', async () => {
    const response = await POST(createRequest({ target: 'HEAD', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    expect(gitReset).toHaveBeenCalledWith('/path/to/worktree', { target: 'HEAD', mode: 'soft' });
  });

  it('accepts a valid commit hash target (mixed) and returns the resulting status', async () => {
    const response = await POST(createRequest({ target: 'deadbeef', mode: 'mixed' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.currentBranch).toBe('feature/x');
    expect(gitReset).toHaveBeenCalledWith('/path/to/worktree', { target: 'deadbeef', mode: 'mixed' });
  });

  it('returns 400 confirmation_mismatch when hard mode confirmBranch does not match', async () => {
    const response = await POST(createRequest({ target: 'HEAD', mode: 'hard', confirmBranch: 'wrong' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('confirmation_mismatch');
    expect(gitReset).not.toHaveBeenCalled();
  });

  it('returns 400 confirmation_mismatch when hard mode confirmBranch is missing', async () => {
    const response = await POST(createRequest({ target: 'HEAD', mode: 'hard' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('confirmation_mismatch');
  });

  it('allows hard mode when confirmBranch matches the current branch', async () => {
    const response = await POST(createRequest({ target: 'HEAD', mode: 'hard', confirmBranch: 'feature/x' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    expect(gitReset).toHaveBeenCalledWith('/path/to/worktree', { target: 'HEAD', mode: 'hard' });
  });

  it('returns 409 default_branch when gitReset rejects a hard reset on the default branch', async () => {
    (gitReset as ReturnType<typeof vi.fn>).mockRejectedValue(new GitResetDefaultBranchError('default'));
    const response = await POST(createRequest({ target: 'HEAD', mode: 'hard', confirmBranch: 'feature/x' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('default_branch');
  });

  it('returns 409 when the index is locked', async () => {
    (gitReset as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    const response = await POST(createRequest({ target: 'HEAD', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(409);
  });

  it('returns 504 on timeout', async () => {
    (gitReset as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timeout'));
    const response = await POST(createRequest({ target: 'HEAD', mode: 'soft' }), { params: { id: 'test-id' } });
    expect(response.status).toBe(504);
  });
});
