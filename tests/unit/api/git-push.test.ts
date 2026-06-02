/**
 * Unit tests for POST /api/worktrees/:id/git/push
 * Issue #783: push / pull / fetch (Phase 5/5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn().mockReturnValue({}) }));
vi.mock('@/lib/db', () => ({ getWorktreeById: vi.fn(), getInitialBranch: vi.fn() }));
vi.mock('@/lib/security/path-validator', () => ({ isValidWorktreeId: vi.fn() }));

vi.mock('@/lib/git/git-utils', async () => {
  const { NextResponse } = await import('next/server');
  class GitTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'GitTimeoutError'; } }
  class GitNotRepoError extends Error { constructor(m: string) { super(m); this.name = 'GitNotRepoError'; } }
  class GitIndexLockedError extends Error { constructor(m: string) { super(m); this.name = 'GitIndexLockedError'; } }
  class GitAuthFailedError extends Error { constructor() { super('Authentication failed'); this.name = 'GitAuthFailedError'; } }
  class GitNonFastForwardError extends Error { constructor() { super('Non-fast-forward'); this.name = 'GitNonFastForwardError'; } }
  class GitProtectedBranchError extends Error { constructor() { super('Protected branch'); this.name = 'GitProtectedBranchError'; } }
  class GitForceWithLeaseStaleError extends Error { constructor() { super('Stale info'); this.name = 'GitForceWithLeaseStaleError'; } }
  class GitNetworkError extends Error { constructor() { super('Network error'); this.name = 'GitNetworkError'; } }
  return {
    gitPush: vi.fn(),
    getGitStatus: vi.fn(),
    GitTimeoutError, GitNotRepoError, GitIndexLockedError,
    GitAuthFailedError, GitNonFastForwardError, GitProtectedBranchError, GitForceWithLeaseStaleError, GitNetworkError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitProtectedBranchError) return NextResponse.json({ error: 'Protected branch', reason: 'protected_branch' }, { status: 409 });
      if (error instanceof GitNonFastForwardError) return NextResponse.json({ error: 'Non-fast-forward', reason: 'non_fast_forward' }, { status: 409 });
      if (error instanceof GitForceWithLeaseStaleError) return NextResponse.json({ error: 'Stale info', reason: 'force_with_lease_stale' }, { status: 409 });
      if (error instanceof GitAuthFailedError) return NextResponse.json({ error: 'Authentication failed', reason: 'auth_failed' }, { status: 401 });
      if (error instanceof GitNetworkError) return NextResponse.json({ error: 'Network error', reason: 'network' }, { status: 502 });
      if (error instanceof GitIndexLockedError) return NextResponse.json({ error: 'locked' }, { status: 409 });
      if (error instanceof GitTimeoutError) return NextResponse.json({ error: 'timeout' }, { status: 504 });
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    },
  };
});

import { POST } from '@/app/api/worktrees/[id]/git/push/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitPush, getGitStatus, GitProtectedBranchError, GitNonFastForwardError, GitForceWithLeaseStaleError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/push', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/push (Issue #783)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (gitPush as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ currentBranch: 'feature/x', initialBranch: 'main', isBranchMismatch: true, commitHash: 'abc', isDirty: false });
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect((await POST(createRequest({}), { params: { id: 'bad!' } })).status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect((await POST(createRequest({}), { params: { id: 'test-id' } })).status).toBe(404);
  });

  it('pushes origin + current branch by default (200)', async () => {
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(gitPush).toHaveBeenCalledWith('/path/to/worktree', {
      remote: 'origin', branch: 'feature/x', force: false, forceWithLease: false, setUpstream: false,
    });
  });

  it('forwards force / forceWithLease / setUpstream and a validated branch', async () => {
    await POST(createRequest({ branch: 'feature/y', forceWithLease: true, setUpstream: true }), { params: { id: 'test-id' } });
    expect(gitPush).toHaveBeenCalledWith('/path/to/worktree', {
      remote: 'origin', branch: 'feature/y', force: false, forceWithLease: true, setUpstream: true,
    });
  });

  // DR4-001 / DR4-005: remote/branch validation.
  it.each(['--receive-pack=x', 'foo bar', 'https://evil:1/x', 'git@h:r', '../e'])(
    'returns 400 invalid_branch_name for a malicious remote %j',
    async (remote) => {
      const res = await POST(createRequest({ remote }), { params: { id: 'test-id' } });
      expect(res.status).toBe(400);
      expect(gitPush).not.toHaveBeenCalled();
    }
  );

  it('returns 400 invalid_branch_name for an option-injection branch', async () => {
    const res = await POST(createRequest({ branch: '--exec=x' }), { params: { id: 'test-id' } });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('invalid_branch_name');
    expect(gitPush).not.toHaveBeenCalled();
  });

  it('maps GitProtectedBranchError to 409 protected_branch', async () => {
    (gitPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitProtectedBranchError());
    const res = await POST(createRequest({ branch: 'main', force: true }), { params: { id: 'test-id' } });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('protected_branch');
  });

  it('maps GitNonFastForwardError to 409 non_fast_forward', async () => {
    (gitPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNonFastForwardError());
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('non_fast_forward');
  });

  it('maps GitForceWithLeaseStaleError to 409 force_with_lease_stale', async () => {
    (gitPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitForceWithLeaseStaleError());
    const res = await POST(createRequest({ forceWithLease: true }), { params: { id: 'test-id' } });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('force_with_lease_stale');
  });
});
