/**
 * Unit tests for POST /api/worktrees/:id/git/unstage
 * Issue #780: stage/unstage/commit operations (Phase 2/5)
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
  class GitIndexLockedError extends Error {
    constructor(msg: string) { super(msg); this.name = 'GitIndexLockedError'; }
  }

  return {
    unstageFiles: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitNotRepoError) {
        return NextResponse.json({ error: 'Not a git repository' }, { status: 400 });
      }
      if (error instanceof GitIndexLockedError) {
        return NextResponse.json({ error: 'Git index is locked by another operation' }, { status: 409 });
      }
      if (error instanceof GitTimeoutError) {
        return NextResponse.json({ error: 'Git command timed out' }, { status: 504 });
      }
      return NextResponse.json({ error: 'Failed to execute git command' }, { status: 500 });
    },
  };
});

import { POST } from '@/app/api/worktrees/[id]/git/unstage/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId, isPathSafe } from '@/lib/security/path-validator';
import { unstageFiles, GitTimeoutError, GitIndexLockedError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/unstage', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/unstage (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (unstageFiles as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('should return 400 for invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'bad!' } });
    expect(response.status).toBe(400);
  });

  it('should return 404 when worktree not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(404);
  });

  it('should return 400 when files is empty', async () => {
    const response = await POST(createRequest({ files: [] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
  });

  it('should return 400 on path traversal (isPathSafe false)', async () => {
    (isPathSafe as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await POST(createRequest({ files: ['../escape'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(400);
    expect(unstageFiles).not.toHaveBeenCalled();
  });

  it('should return 200 and call unstageFiles on success', async () => {
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(200);
    expect(unstageFiles).toHaveBeenCalledWith('/path/to/worktree', ['a.ts']);
  });

  it('should return 409 when the index is locked', async () => {
    (unstageFiles as ReturnType<typeof vi.fn>).mockRejectedValue(new GitIndexLockedError('locked'));
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(409);
  });

  it('should return 504 on timeout', async () => {
    (unstageFiles as ReturnType<typeof vi.fn>).mockRejectedValue(new GitTimeoutError('timeout'));
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(504);
  });

  it('should return 500 on general error', async () => {
    (unstageFiles as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const response = await POST(createRequest({ files: ['a.ts'] }), { params: { id: 'test-id' } });
    expect(response.status).toBe(500);
  });
});
