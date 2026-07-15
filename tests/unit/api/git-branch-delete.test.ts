/**
 * Unit tests for POST /api/worktrees/:id/git/branch/delete
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 *
 * Uses POST + body (NOT DELETE + [name]) because branch names contain '/'.
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
  class GitBranchNotMergedError extends Error { constructor(m: string) { super(m); this.name = 'GitBranchNotMergedError'; } }
  class GitCurrentBranchError extends Error { constructor(m: string) { super(m); this.name = 'GitCurrentBranchError'; } }
  class GitDefaultBranchError extends Error { constructor(m: string) { super(m); this.name = 'GitDefaultBranchError'; } }

  return {
    deleteBranch: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    GitBranchNotFoundError,
    GitBranchNotMergedError,
    GitCurrentBranchError,
    GitDefaultBranchError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitBranchNotFoundError) {
        return NextResponse.json({ error: 'Branch not found', reason: 'branch_not_found' }, { status: 404 });
      }
      if (error instanceof GitBranchNotMergedError) {
        return NextResponse.json({ error: 'not merged', reason: 'not_merged' }, { status: 409 });
      }
      if (error instanceof GitCurrentBranchError) {
        return NextResponse.json({ error: 'current', reason: 'current_branch' }, { status: 409 });
      }
      if (error instanceof GitDefaultBranchError) {
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

import { POST } from '@/app/api/worktrees/[id]/git/branch/delete/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import {
  deleteBranch,
  GitBranchNotMergedError,
  GitCurrentBranchError,
  GitDefaultBranchError,
} from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/branch/delete', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/branch/delete (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (deleteBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
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
    expect(deleteBranch).not.toHaveBeenCalled();
  });

  it('returns 200 with the deleted branch on success', async () => {
    const response = await POST(createRequest({ name: 'feature/done' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.deleted).toBe('feature/done');
    expect(deleteBranch).toHaveBeenCalledWith('/path/to/worktree', { name: 'feature/done', force: false });
  });

  it('forwards the force flag', async () => {
    await POST(createRequest({ name: 'feature/wip', force: true }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(deleteBranch).toHaveBeenCalledWith('/path/to/worktree', { name: 'feature/wip', force: true });
  });

  it('returns 409 not_merged for an unmerged branch deleted without force', async () => {
    (deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitBranchNotMergedError('not merged'));
    const response = await POST(createRequest({ name: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('not_merged');
  });

  it('returns 409 current_branch when deleting the current branch', async () => {
    (deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitCurrentBranchError('current'));
    const response = await POST(createRequest({ name: 'main' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('current_branch');
  });

  it('returns 409 default_branch when deleting the default branch', async () => {
    (deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitDefaultBranchError('default'));
    const response = await POST(createRequest({ name: 'main' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('default_branch');
  });

  it('returns 500 on a generic error', async () => {
    (deleteBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const response = await POST(createRequest({ name: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(500);
  });
});
