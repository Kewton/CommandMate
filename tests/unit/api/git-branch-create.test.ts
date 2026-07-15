/**
 * Unit tests for POST /api/worktrees/:id/git/branch/create
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

  class GitTimeoutError extends Error { constructor(m: string) { super(m); this.name = 'GitTimeoutError'; } }
  class GitNotRepoError extends Error { constructor(m: string) { super(m); this.name = 'GitNotRepoError'; } }
  class GitIndexLockedError extends Error { constructor(m: string) { super(m); this.name = 'GitIndexLockedError'; } }
  class GitBranchNotFoundError extends Error { constructor(m: string) { super(m); this.name = 'GitBranchNotFoundError'; } }

  return {
    createBranch: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    GitBranchNotFoundError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitBranchNotFoundError) {
        return NextResponse.json({ error: 'Branch not found', reason: 'branch_not_found' }, { status: 404 });
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

import { POST } from '@/app/api/worktrees/[id]/git/branch/create/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import { createBranch, GitBranchNotFoundError } from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/branch/create', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/branch/create (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (createBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await POST(createRequest({ name: 'feature/x' }), { params: Promise.resolve({ id: 'bad!' }) });
    expect(response.status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({ name: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(404);
  });

  it('returns 400 invalid_branch_name for a missing name', async () => {
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_branch_name');
    expect(createBranch).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_branch_name for a bad name', async () => {
    const response = await POST(createRequest({ name: '-x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(400);
  });

  it('returns 200 with the created branch on success', async () => {
    const response = await POST(createRequest({ name: 'feature/new' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.branch.name).toBe('feature/new');
    expect(data.branch.isCurrent).toBe(false);
    expect(createBranch).toHaveBeenCalledWith('/path/to/worktree', { name: 'feature/new', from: undefined });
  });

  it('forwards a validated from ref', async () => {
    await POST(createRequest({ name: 'feature/new', from: 'main' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(createBranch).toHaveBeenCalledWith('/path/to/worktree', { name: 'feature/new', from: 'main' });
  });

  it('rejects an invalid from ref with 400', async () => {
    const response = await POST(
      createRequest({ name: 'feature/new', from: '../escape' }),
      { params: Promise.resolve({ id: 'test-id' }) }
    );
    expect(response.status).toBe(400);
    expect(createBranch).not.toHaveBeenCalled();
  });

  it('returns 404 branch_not_found when the from ref does not exist', async () => {
    (createBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitBranchNotFoundError('nope'));
    const response = await POST(createRequest({ name: 'feature/new', from: 'gone' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.reason).toBe('branch_not_found');
  });

  it('returns 500 on a generic error', async () => {
    (createBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const response = await POST(createRequest({ name: 'feature/new' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(500);
  });
});
