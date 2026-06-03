/**
 * Unit tests for POST /api/worktrees/:id/git/pull
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
  class GitNoUpstreamError extends Error { constructor() { super('No upstream'); this.name = 'GitNoUpstreamError'; } }
  class GitNetworkError extends Error { constructor() { super('Network error'); this.name = 'GitNetworkError'; } }
  return {
    gitPull: vi.fn(),
    getGitStatus: vi.fn(),
    GitTimeoutError, GitNotRepoError, GitIndexLockedError,
    GitAuthFailedError, GitNonFastForwardError, GitNoUpstreamError, GitNetworkError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitAuthFailedError) return NextResponse.json({ error: 'Authentication failed', reason: 'auth_failed' }, { status: 401 });
      if (error instanceof GitNonFastForwardError) return NextResponse.json({ error: 'Non-fast-forward', reason: 'non_fast_forward' }, { status: 409 });
      if (error instanceof GitNoUpstreamError) return NextResponse.json({ error: 'No upstream', reason: 'no_upstream' }, { status: 400 });
      if (error instanceof GitNetworkError) return NextResponse.json({ error: 'Network error', reason: 'network' }, { status: 502 });
      if (error instanceof GitIndexLockedError) return NextResponse.json({ error: 'locked' }, { status: 409 });
      if (error instanceof GitTimeoutError) return NextResponse.json({ error: 'timeout' }, { status: 504 });
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    },
  };
});

import { POST } from '@/app/api/worktrees/[id]/git/pull/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitPull, getGitStatus, GitNonFastForwardError, GitAuthFailedError, GitIndexLockedError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/pull', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/pull (Issue #783)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (gitPull as ReturnType<typeof vi.fn>).mockResolvedValue({ conflict: false });
    (getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({ currentBranch: 'main', initialBranch: 'main', isBranchMismatch: false, commitHash: 'abc', isDirty: false });
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    expect((await POST(createRequest({}), { params: { id: 'bad!' } })).status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    expect((await POST(createRequest({}), { params: { id: 'test-id' } })).status).toBe(404);
  });

  it('pulls origin + current branch by default (200)', async () => {
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(gitPull).toHaveBeenCalledWith('/path/to/worktree', { remote: 'origin', branch: 'main', rebase: false, ffOnly: false });
  });

  it('forwards rebase + validated remote/branch', async () => {
    await POST(createRequest({ remote: 'upstream', branch: 'feature/x', rebase: true }), { params: { id: 'test-id' } });
    expect(gitPull).toHaveBeenCalledWith('/path/to/worktree', { remote: 'upstream', branch: 'feature/x', rebase: true, ffOnly: false });
  });

  it('returns 400 invalid_options when rebase and ffOnly are both true', async () => {
    const res = await POST(createRequest({ rebase: true, ffOnly: true }), { params: { id: 'test-id' } });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('invalid_options');
    expect(gitPull).not.toHaveBeenCalled();
  });

  it('returns 200 conflict with conflictFiles', async () => {
    (gitPull as ReturnType<typeof vi.fn>).mockResolvedValue({ conflict: true, conflictFiles: ['src/a.ts'] });
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.conflict).toBe(true);
    expect(data.conflictFiles).toEqual(['src/a.ts']);
  });

  // DR4-001 / DR4-005: remote validation.
  it.each(['--upload-pack=x', 'foo bar', 'https://evil:1/x', 'git@h:r', '../e'])(
    'returns 400 invalid_branch_name for a malicious remote %j',
    async (remote) => {
      const res = await POST(createRequest({ remote }), { params: { id: 'test-id' } });
      expect(res.status).toBe(400);
      expect(gitPull).not.toHaveBeenCalled();
    }
  );

  it('returns 400 invalid_branch_name for an option-injection branch', async () => {
    const res = await POST(createRequest({ branch: '--exec=x' }), { params: { id: 'test-id' } });
    expect(res.status).toBe(400);
    expect((await res.json()).reason).toBe('invalid_branch_name');
    expect(gitPull).not.toHaveBeenCalled();
  });

  it('maps GitNonFastForwardError to 409 non_fast_forward', async () => {
    (gitPull as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNonFastForwardError());
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe('non_fast_forward');
  });

  it('maps GitAuthFailedError to 401', async () => {
    (gitPull as ReturnType<typeof vi.fn>).mockRejectedValue(new GitAuthFailedError());
    expect((await POST(createRequest({}), { params: { id: 'test-id' } })).status).toBe(401);
  });

  it('maps GitIndexLockedError to 409', async () => {
    (gitPull as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    expect((await POST(createRequest({}), { params: { id: 'test-id' } })).status).toBe(409);
  });
});
