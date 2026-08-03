/**
 * Unit tests for POST /api/repositories/scan
 *
 * Issue #1328: CM_ROOT_DIR's repository auto-discovery was removed, but the two
 * roles that make CM_ROOT_DIR the "managed scope" must survive:
 *   1. the registration boundary enforced here (the allowed-root check)
 *   2. the clone destination (covered by tests/unit/lib/clone-manager.test.ts)
 *
 * These tests pin role 1. Neither `@/lib/security/path-validator` nor
 * `@/lib/fs/browse-roots` is mocked: the point is that the route really rejects
 * out-of-scope paths, not merely that it calls a collaborator.
 *
 * Issue #1517 widened the boundary from CM_ROOT_DIR alone to the allowed-root
 * set, and that check now also resolves symlinks — so the root has to be a real
 * directory here rather than a string literal.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path2 from 'path';
import { NextRequest } from 'next/server';

/** Assigned in beforeAll; read lazily by the getEnv mock below. */
let CM_ROOT_DIR = '';

vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getEnv: () => ({ CM_ROOT_DIR }),
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

// Issue #1348: the scan route now registers a `repositories` row for each
// discovered repository. Mock the db-repository layer so the route's DB access
// is exercised without a real better-sqlite3 instance.
vi.mock('@/lib/db/db-repository', () => ({
  getRepositoryByPath: vi.fn(),
  createRepository: vi.fn(),
}));

import { POST } from '@/app/api/repositories/scan/route';
import { scanWorktrees } from '@/lib/git/worktrees';
import { syncWorktreesAndCleanup } from '@/lib/session-cleanup';
import { getRepositoryByPath, createRepository } from '@/lib/db/db-repository';
import { removeTempDir } from '@tests/helpers/temp-dir';

function postRequest(body: unknown): NextRequest {
  return new NextRequest('http://localhost:3000/api/repositories/scan', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

describe('POST /api/repositories/scan', () => {
  let sandbox: string;

  beforeAll(() => {
    sandbox = mkdtempSync(path2.join(tmpdir(), 'cm-1517-scan-'));
    CM_ROOT_DIR = path2.join(sandbox, 'repos');
    mkdirSync(CM_ROOT_DIR, { recursive: true });
  });

  afterAll(() => {
    removeTempDir(sandbox);
    delete process.env.CM_BROWSE_ROOTS;
  });

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.CM_BROWSE_ROOTS;
  });

  describe('CM_ROOT_DIR registration boundary (Issue #1328 role 1)', () => {
    // Paths measured on a real deployment in Issue #1328; each must stay a 400.
    // Thunks, because CM_ROOT_DIR is only known once beforeAll has run.
    it.each([
      ['a repository outside the managed scope', () => '/tmp/repos/my-flask_app'],
      ['a system directory', () => '/etc'],
      ['a relative traversal escape', () => '../../../etc'],
      ['a traversal escape that re-enters the root', () => `${CM_ROOT_DIR}/../../../etc`],
    ])('should reject %s with 400', async (_label, makePath) => {
      const response = await POST(postRequest({ repositoryPath: makePath() }));

      expect(response.status).toBe(400);
      // Issue #1517: the message now names the allowed roots, so a path that is
      // merely out of scope no longer reads as a typo.
      const body = await response.json();
      expect(body.error).toContain('Invalid or unsafe repository path');
      expect(body.error).toContain(CM_ROOT_DIR);
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
    // No worktrees -> nothing to register.
    expect(createRepository).not.toHaveBeenCalled();
  });

  // Issue #1348: scan must leave a `repositories` row behind (like the clone/env
  // routes) so the repository shows up in the management screen and is picked up
  // by subsequent sync runs.
  describe('repositories row registration (Issue #1348)', () => {
    beforeEach(() => {
      vi.mocked(syncWorktreesAndCleanup).mockResolvedValue({
        syncResult: { deletedIds: [], upsertedCount: 1 },
        cleanupWarnings: [],
      } as never);
    });

    it('registers a repositories row for a newly scanned repository', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-a-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-a`,
          repositoryName: 'repo-a',
        },
      ] as never);
      // No existing row -> a fresh one must be created.
      vi.mocked(getRepositoryByPath).mockReturnValue(null);

      const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/repo-a` }));

      expect(response.status).toBe(200);
      expect(getRepositoryByPath).toHaveBeenCalledWith(expect.anything(), `${CM_ROOT_DIR}/repo-a`);
      // Mirrors the clone path: local source, enabled + visible by default.
      expect(createRepository).toHaveBeenCalledTimes(1);
      expect(createRepository).toHaveBeenCalledWith(expect.anything(), {
        name: 'repo-a',
        path: `${CM_ROOT_DIR}/repo-a`,
        cloneSource: 'local',
        enabled: true,
        visible: true,
      });
      // Registration must not replace the existing worktree sync.
      expect(syncWorktreesAndCleanup).toHaveBeenCalledTimes(1);
    });

    it('does not overwrite an existing repositories row (idempotent)', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-a-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-a`,
          repositoryName: 'repo-a',
        },
      ] as never);
      // A row already exists (possibly disabled/hidden by the user).
      vi.mocked(getRepositoryByPath).mockReturnValue({ id: 'existing' } as never);

      const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/repo-a` }));

      expect(response.status).toBe(200);
      expect(createRepository).not.toHaveBeenCalled();
      expect(syncWorktreesAndCleanup).toHaveBeenCalledTimes(1);
    });

    it('registers each repository once even with multiple worktrees', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-a-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-a`,
          repositoryName: 'repo-a',
        },
        {
          id: 'repo-a-feature',
          repositoryPath: `${CM_ROOT_DIR}/repo-a`,
          repositoryName: 'repo-a',
        },
      ] as never);
      vi.mocked(getRepositoryByPath).mockReturnValue(null);

      const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/repo-a` }));

      expect(response.status).toBe(200);
      // De-duplicated by repositoryPath -> a single row.
      expect(createRepository).toHaveBeenCalledTimes(1);
    });

    it('falls back to the path basename when repositoryName is empty', async () => {
      vi.mocked(scanWorktrees).mockResolvedValue([
        {
          id: 'repo-c-main',
          repositoryPath: `${CM_ROOT_DIR}/repo-c`,
          repositoryName: '',
        },
      ] as never);
      vi.mocked(getRepositoryByPath).mockReturnValue(null);

      const response = await POST(postRequest({ repositoryPath: `${CM_ROOT_DIR}/repo-c` }));

      expect(response.status).toBe(200);
      expect(createRepository).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ name: 'repo-c', path: `${CM_ROOT_DIR}/repo-c` })
      );
    });
  });
});
