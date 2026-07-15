/**
 * Unit tests for POST /api/worktrees/:id/git/stash/push
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
  class GitNothingToStashError extends Error { constructor(m: string) { super(m); this.name = 'GitNothingToStashError'; } }
  return {
    stashPush: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    GitNothingToStashError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitNothingToStashError) {
        return NextResponse.json({ error: 'No local changes to stash', reason: 'nothing_to_stash' }, { status: 400 });
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

import { POST } from '@/app/api/worktrees/[id]/git/stash/push/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { stashPush, GitTimeoutError, GitIndexLockedError, GitNothingToStashError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/stash/push', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/stash/push (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (stashPush as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'bad!' }) });
    expect(response.status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(404);
  });

  it('returns 200 and calls stashPush with no options for an empty body', async () => {
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(200);
    expect(stashPush).toHaveBeenCalledWith('/path/to/worktree', { message: undefined, includeUntracked: false });
  });

  it('forwards message and includeUntracked', async () => {
    await POST(createRequest({ message: 'wip', includeUntracked: true }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(stashPush).toHaveBeenCalledWith('/path/to/worktree', { message: 'wip', includeUntracked: true });
  });

  it('returns 400 nothing_to_stash when the tree is clean', async () => {
    (stashPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitNothingToStashError('clean'));
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('nothing_to_stash');
  });

  it('returns 409 when the index is locked', async () => {
    (stashPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
  });

  it('returns 504 on timeout', async () => {
    (stashPush as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timeout'));
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(504);
  });

  it('returns 500 on a generic error', async () => {
    (stashPush as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(500);
  });
});
