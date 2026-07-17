/**
 * Unit tests for POST /api/repositories/scan
 *
 * Issue #1328: CM_ROOT_DIR's repository auto-discovery was removed, but the two
 * roles that make CM_ROOT_DIR the "managed scope" must survive:
 *   1. the registration boundary enforced here (isPathSafe against CM_ROOT_DIR)
 *   2. the clone destination (covered by tests/unit/lib/clone-manager.test.ts)
 *
 * These tests pin role 1. `@/lib/security/path-validator` is intentionally NOT
 * mocked: the point is that the route really rejects out-of-scope paths, not
 * merely that it calls a collaborator.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest } from 'next/server';

const CM_ROOT_DIR = '/Users/testuser/repos';

vi.mock('@/lib/env', () => ({
  getEnv: vi.fn(() => ({ CM_ROOT_DIR })),
}));

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn().mockReturnValue({}),
}));

vi.mock('@/lib/git/worktrees', () => ({
  scanWorktrees: vi.fn(),
}));

vi.mock('@/lib/session-cleanup', () => ({
  syncWorktreesAndCleanup: vi.fn(),
}));

import { POST } from '@/app/api/repositories/scan/route';
import { scanWorktrees } from '@/lib/git/worktrees';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/repositories/scan', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/repositories/scan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('CM_ROOT_DIR registration boundary (Issue #1328 role 1)', () => {
    // Paths measured on a real deployment in Issue #1328; each must stay a 400.
    it.each([
      ['a repository outside the managed scope', '/tmp/repos/my-flask_app'],
      ['a system directory', '/etc'],
      ['a relative traversal escape', '../../../etc'],
      ['a traversal escape that re-enters the root', '/Users/testuser/repos/../../../etc'],
    ])('should reject %s with 400', async (_label, repositoryPath) => {
      const response = await POST(postRequest({ repositoryPath }));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Invalid or unsafe repository path',
      });
      // The boundary must reject before any git command runs.
      expect(scanWorktrees).not.toHaveBeenCalled();
    });

    it('should accept a repository inside the managed scope', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-a-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-a`,
          repositoryName: 'repo-a',
        },
      ] as never);
      vi.mocked(syncWorktreesAndCleanup).mockResolvedValue({
        syncResult: { deletedIds: [], upsertedCount: 1 },
        cleanupWarnings: [],
      } as never);

      const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/repo-a` }));

      expect(response.status).toBe(200);
      expect(scanWorktrees).toHaveBeenCalledWith(`${CM_ROOT_DIR}/repo-a`);
    });

    it('should resolve a relative path against CM_ROOT_DIR', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-b-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-b`,
          repositoryName: 'repo-b',
        },
      ] as never);
      vi.mocked(syncWorktreesAndCleanup).mockResolvedValue({
        syncResult: { deletedIds: [], upsertedCount: 1 },
        cleanupWarnings: [],
      } as never);

      const response = await POST(postRequest({ repositoryPath: 'repo-b' }));

      expect(response.status).toBe(200);
      expect(scanWorktrees).toHaveBeenCalledWith(`${CM_ROOT_DIR}/repo-b`);
    });
  });

  describe('input validation', () => {
    it.each([
      ['a missing repositoryPath', {}],
      ['an empty repositoryPath', { repositoryPath: '' }],
      ['a non-string repositoryPath', { repositoryPath: 123 }],
    ])('should reject %s with 400', async (_label, body) => {
      const response = await POST(postRequest(body));

      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toEqual({
        error: 'Repository path is required',
      });
      expect(scanWorktrees).not.toHaveBeenCalled();
    });
  });

  it('should return 404 when the path holds no worktrees', async () => {
    vi.mocked(scanWorktrees).mockResolvedValue([]);

    const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/empty` }));

    expect(response.status).toBe(404);
  });
});
