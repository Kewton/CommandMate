/**
 * Unit tests for POST /api/worktrees/:id/git/checkout
 * Issue #781: branch list / checkout / create / delete (Phase 3/5)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/db', () => ({
  getWorktreeById: vi.fn(),
  getInitialBranch: vi.fn(),
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
  class GitDirtyError extends Error { constructor(m: string) { super(m); this.name = 'GitDirtyError'; } }
  class GitBranchCheckedOutElsewhereError extends Error {
    worktreePath: string;
    constructor(m: string, wt: string) { super(m); this.name = 'GitBranchCheckedOutElsewhereError'; this.worktreePath = wt; }
  }

  return {
    checkoutBranch: vi.fn(),
    getGitStatus: vi.fn(),
    GitTimeoutError,
    GitNotRepoError,
    GitIndexLockedError,
    GitBranchNotFoundError,
    GitDirtyError,
    GitBranchCheckedOutElsewhereError,
    handleGitApiError: (error: unknown) => {
      if (error instanceof GitBranchNotFoundError) {
        return NextResponse.json({ error: 'Branch not found', reason: 'branch_not_found' }, { status: 404 });
      }
      if (error instanceof GitDirtyError) {
        return NextResponse.json({ error: 'dirty', reason: 'dirty' }, { status: 409 });
      }
      if (error instanceof GitBranchCheckedOutElsewhereError) {
        return NextResponse.json(
          { error: 'checked_out_elsewhere', reason: 'checked_out_elsewhere', worktreePath: error.worktreePath },
          { status: 409 }
        );
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

import { POST } from '@/app/api/worktrees/[id]/git/checkout/route';
import { getWorktreeById } from '@/lib/db';
import { isValidWorktreeId } from '@/lib/security/path-validator';
import {
  checkoutBranch,
  getGitStatus,
  GitDirtyError,
  GitBranchCheckedOutElsewhereError,
  GitBranchNotFoundError,
  GitIndexLockedError,
  GitTimeoutError,
} from '@/lib/git/git-utils';

function createRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('/api/worktrees/test-id/git/checkout', 'http://localhost:3000'), {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('POST /api/worktrees/:id/git/checkout (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(true);
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue({ id: 'test-id', path: '/path/to/worktree' });
    (checkoutBranch as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    (getGitStatus as ReturnType<typeof vi.fn>).mockResolvedValue({
      currentBranch: 'feature/x',
      initialBranch: 'main',
      isBranchMismatch: true,
      commitHash: 'abc',
      isDirty: false,
    });
  });

  it('returns 400 for an invalid worktree ID', async () => {
    (isValidWorktreeId as ReturnType<typeof vi.fn>).mockReturnValue(false);
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'bad!' }) });
    expect(response.status).toBe(400);
  });

  it('returns 404 when the worktree is not found', async () => {
    (getWorktreeById as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(404);
  });

  it('returns 400 invalid_branch_name for a missing branch', async () => {
    const response = await POST(createRequest({}), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_branch_name');
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it('returns 400 invalid_branch_name for an option-injection branch name', async () => {
    const response = await POST(createRequest({ branch: '-force' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(400);
    const data = await response.json();
    expect(data.reason).toBe('invalid_branch_name');
  });

  it('returns 200 with currentBranch and isDirty on success', async () => {
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.success).toBe(true);
    expect(data.currentBranch).toBe('feature/x');
    expect(data.isDirty).toBe(false);
    expect(checkoutBranch).toHaveBeenCalledWith('/path/to/worktree', {
      branch: 'feature/x',
      createIfMissing: false,
      from: undefined,
      force: false,
    });
  });

  it('forwards createIfMissing / from / force options', async () => {
    await POST(
      createRequest({ branch: 'feature/new', createIfMissing: true, from: 'main', force: true }),
      { params: Promise.resolve({ id: 'test-id' }) }
    );
    expect(checkoutBranch).toHaveBeenCalledWith('/path/to/worktree', {
      branch: 'feature/new',
      createIfMissing: true,
      from: 'main',
      force: true,
    });
  });

  it('validates the from ref as a branch name (400 invalid_branch_name)', async () => {
    const response = await POST(
      createRequest({ branch: 'feature/new', createIfMissing: true, from: '-bad' }),
      { params: Promise.resolve({ id: 'test-id' }) }
    );
    expect(response.status).toBe(400);
    expect(checkoutBranch).not.toHaveBeenCalled();
  });

  it('returns 409 dirty when the tree is dirty', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitDirtyError('dirty'));
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('dirty');
  });

  it('returns 409 checked_out_elsewhere with worktreePath', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GitBranchCheckedOutElsewhereError('elsewhere', '/other/wt')
    );
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
    const data = await response.json();
    expect(data.reason).toBe('checked_out_elsewhere');
    expect(data.worktreePath).toBe('/other/wt');
  });

  it('returns 404 branch_not_found for a missing branch', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new GitBranchNotFoundError('nope'));
    const response = await POST(createRequest({ branch: 'feature/nope' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(404);
    const data = await response.json();
    expect(data.reason).toBe('branch_not_found');
  });

  it('returns 409 when the git index is locked (index.lock)', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GitIndexLockedError('index.lock present')
    );
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(409);
  });

  it('returns 504 when the git write times out', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(
      new GitTimeoutError('timed out')
    );
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(504);
  });

  it('returns 500 on a generic error', async () => {
    (checkoutBranch as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'));
    const response = await POST(createRequest({ branch: 'feature/x' }), { params: Promise.resolve({ id: 'test-id' }) });
    expect(response.status).toBe(500);
  });
});
