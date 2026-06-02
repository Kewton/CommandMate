/**
 * Unit tests for POST /api/worktrees/:id/git/fetch
 * Issue #783: push / pull / fetch (Phase 5/5)
 *
 * validateGitBranchName / resolveWorktreeOr404 are the REAL implementations
 * (only @/lib/git/git-utils, @/lib/db, @/lib/security/path-validator are mocked),
 * so the DR4-001 option-injection and DR4-005 SSRF rejections exercise the real
 * branch-name validator.
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
  class GitAuthFailedError extends Error { constructor() { super('Authentication failed'); this.name = 'GitAuthFailedError'; } }
  class GitNetworkError extends Error { constructor() { super('Network error'); this.name = 'GitNetworkError'; } }
  return {
    gitFetch: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitAuthFailedError,
    GitNetworkError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitAuthFailedError) {
        return NextResponse.json({ error: 'Authentication failed', reason: 'auth_failed' }, { status: 401 });
      }
      if (error instanceof GitNetworkError) {
        return NextResponse.json({ error: 'Network error', reason: 'network' }, { status: 502 });
      }
      if (error instanceof GitNotRepoError) {
        return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'timeout' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed' }, { status: 500 });
    },
  };
});

import { POST } from '@/app/api/worktrees/[id]/git/fetch/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { gitFetch, GitAuthFailedError, GitNetworkError, GitTimeoutError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/fetch', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/fetch (Issue #783)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (gitFetch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const res = await POST(createRequest({}), { params: { id: 'bad!' } });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(404);
  });

  it('fetches from origin by default (200)', async () => {
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.success).toBe(true);
    expect(gitFetch).toHaveBeenCalledWith('/path/to/worktree', { remote: 'origin', prune: false });
  });

  it('forwards prune and a validated remote', async () => {
    await POST(createRequest({ remote: 'upstream', prune: true }), { params: { id: 'test-id' } });
    expect(gitFetch).toHaveBeenCalledWith('/path/to/worktree', { remote: 'upstream', prune: true });
  });

  // DR4-001: option-injection via remote is rejected by validateGitBranchName.
  it.each(['--upload-pack=x', '--exec=x', 'foo bar'])(
    'returns 400 invalid_branch_name for an option-injection remote %j',
    async (remote) => {
      const res = await POST(createRequest({ remote }), { params: { id: 'test-id' } });
      expect(res.status).toBe(400);
      const data = await res.json();
      expect(data.reason).toBe('invalid_branch_name');
      expect(gitFetch).not.toHaveBeenCalled();
    }
  );

  // DR4-005: SSRF via arbitrary-URL/path remote is rejected (':' / '.' chars).
  it.each(['https://attacker.internal:8080/x', 'git@host:repo', 'file:///etc', '../evil'])(
    'returns 400 invalid_branch_name for a URL/path remote %j (SSRF closed)',
    async (remote) => {
      const res = await POST(createRequest({ remote }), { params: { id: 'test-id' } });
      expect(res.status).toBe(400);
      expect(gitFetch).not.toHaveBeenCalled();
    }
  );

  it('maps GitAuthFailedError to 401 auth_failed', async () => {
    (gitFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitAuthFailedError());
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(401);
    expect((await res.json()).reason).toBe('auth_failed');
  });

  it('maps GitNetworkError to 502 network', async () => {
    (gitFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNetworkError());
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(502);
    expect((await res.json()).reason).toBe('network');
  });

  it('maps GitTimeoutError to 504', async () => {
    (gitFetch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('t'));
    const res = await POST(createRequest({}), { params: { id: 'test-id' } });
    expect(res.status).toBe(504);
  });
});
