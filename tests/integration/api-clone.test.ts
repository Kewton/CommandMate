/**
 * Integration Tests: Clone API Endpoints
 * Issue #71: Clone URL registration feature
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NextRequest } from 'next/server';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import {
  createRepository,
  createCloneJob,
  updateCloneJob,
  getCloneJob,
} from '@/lib/db/db-repository';

// Mock environment variables (must be before route imports). Partial mock via
// importOriginal keeps the module's other exports real (e.g. getLogConfig, used
// by the logger) so only getEnv is overridden (Issue #1102).
vi.mock('@/lib/env', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/env')>()),
  getEnv: () => ({
    CM_ROOT_DIR: '/test/clone-root',
    CM_PORT: 3000,
    CM_BIND: '127.0.0.1',
    CM_DB_PATH: '/test/db',
  }),
}));

// Mock database instance
let mockDb: Database.Database;

vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: () => mockDb,
}));

// Mock fs
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>();
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  };
});

// Mock child_process - only stub spawn (used by CloneManager to launch git
// clone) and don't auto-call callbacks to prevent async issues. Keep the rest of
// the module real via importOriginal so git-exec's `promisify(execFile)` at
// module load has a real execFile (Issue #1102: the previous full mock omitted
// execFile, throwing "No execFile export" and failing the whole file).
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: vi.fn(() => ({
    pid: 12345,
    stderr: {
      on: vi.fn(),
    },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

// Issue #1480: mock forkRepository (network gh call) while keeping the real
// ForkError class so the route's `instanceof ForkError` branch works.
vi.mock('@/lib/git/fork-manager', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/git/fork-manager')>()),
  forkRepository: vi.fn(),
}));

// Import routes after mocking
import { POST as postClone } from '@/app/api/repositories/clone/route';
import { GET as getCloneStatus } from '@/app/api/repositories/clone/[jobId]/route';
import { forkRepository, ForkError } from '@/lib/git/fork-manager';

describe('Clone API', () => {
  beforeEach(() => {
    mockDb = new Database(':memory:');
    runMigrations(mockDb);
    vi.clearAllMocks();
  });

  afterEach(() => {
    mockDb.close();
  });

  describe('POST /api/repositories/clone', () => {
    it('should return 400 for missing cloneUrl', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({}),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('EMPTY_URL');
    });

    it('should return 400 for invalid URL format', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({ cloneUrl: 'not-a-url' }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_URL_FORMAT');
    });

    it('should return 409 for duplicate repository', async () => {
      // Create existing repository
      createRepository(mockDb, {
        name: 'existing-repo',
        path: '/path/to/existing-repo',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      // Issue #1350: a duplicate is only rejected when the existing repository's
      // directory is still on disk. The single existsSync() call in the duplicate
      // path is for the existing repo's directory — make it report a live
      // directory so this stays a real duplicate rather than a cleaned-up ghost.
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValueOnce(true);

      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({ cloneUrl: 'https://github.com/test/repo.git' }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('DUPLICATE_CLONE_URL');
    });

    it('should return 409 for clone in progress', async () => {
      // Create active clone job
      createCloneJob(mockDb, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({ cloneUrl: 'https://github.com/test/repo.git' }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(409);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('CLONE_IN_PROGRESS');
    });

    it('should start clone job for valid HTTPS URL', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git' }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(data.jobId).toBeDefined();
      expect(data.status).toBe('pending');

      // Verify job was created in database
      const job = getCloneJob(mockDb, data.jobId);
      expect(job).not.toBeNull();
      expect(job?.cloneUrl).toBe('https://github.com/test/new-repo.git');
    });

    describe('fork option (Issue #1480)', () => {
      it('clones the resolved fork and records upstream when fork:true', async () => {
        vi.mocked(forkRepository).mockResolvedValue({
          forkUrl: 'https://github.com/me/new-repo.git',
          upstreamUrl: 'https://github.com/test/new-repo.git',
          forkFullName: 'me/new-repo',
        });

        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git', fork: true }),
        });

        const response = await postClone(request);
        const data = await response.json();

        expect(response.status).toBe(202);
        expect(data.success).toBe(true);
        expect(forkRepository).toHaveBeenCalledWith('https://github.com/test/new-repo.git');

        // The background clone job targets the fork URL, not the original.
        const job = getCloneJob(mockDb, data.jobId);
        expect(job?.cloneUrl).toBe('https://github.com/me/new-repo.git');
      });

      it('does not fork when fork flag is omitted', async () => {
        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/plain-repo.git' }),
        });

        await postClone(request);

        expect(forkRepository).not.toHaveBeenCalled();
      });

      it('returns 401 when gh is not authenticated', async () => {
        vi.mocked(forkRepository).mockRejectedValue(
          new ForkError('GH_NOT_AUTHENTICATED', 'GitHub CLI is not authenticated.')
        );

        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git', fork: true }),
        });

        const response = await postClone(request);
        const data = await response.json();

        expect(response.status).toBe(401);
        expect(data.success).toBe(false);
        expect(data.error.code).toBe('GH_NOT_AUTHENTICATED');
        expect(data.error.category).toBe('auth');
      });

      it('returns 400 when gh is not installed', async () => {
        vi.mocked(forkRepository).mockRejectedValue(
          new ForkError('GH_NOT_AVAILABLE', 'gh is not installed.')
        );

        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git', fork: true }),
        });

        const response = await postClone(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.code).toBe('GH_NOT_AVAILABLE');
      });

      it('returns 422 when the fork operation fails', async () => {
        vi.mocked(forkRepository).mockRejectedValue(
          new ForkError('FORK_FAILED', 'Failed to fork test/new-repo: HTTP 403')
        );

        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git', fork: true }),
        });

        const response = await postClone(request);
        const data = await response.json();

        expect(response.status).toBe(422);
        expect(data.error.code).toBe('FORK_FAILED');
      });

      it('returns 400 when fork flag is not a boolean', async () => {
        const request = new NextRequest('http://localhost/api/repositories/clone', {
          method: 'POST',
          body: JSON.stringify({ cloneUrl: 'https://github.com/test/new-repo.git', fork: 'yes' }),
        });

        const response = await postClone(request);
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.error.code).toBe('INVALID_FORK_FLAG');
        expect(forkRepository).not.toHaveBeenCalled();
      });
    });

    it('should return 400 when targetDir is not a string (D4-002)', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({
          cloneUrl: 'https://github.com/test/repo.git',
          targetDir: { malicious: true },
        }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_TARGET_PATH');
      expect(data.error.message).toBe('targetDir must be a string');
    });

    it('should start clone job for valid SSH URL', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({ cloneUrl: 'git@github.com:test/ssh-repo.git' }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);
      expect(data.jobId).toBeDefined();
    });

    it('R-001: trims whitespace from targetDir', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({
          cloneUrl: 'https://github.com/test/trim-repo.git',
          targetDir: '  my-repo  ',
        }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);

      // Verify the job was created with trimmed targetDir resolved under basePath
      const job = getCloneJob(mockDb, data.jobId);
      expect(job?.targetPath).toBe('/test/clone-root/my-repo');
    });

    it('R-002: treats whitespace-only targetDir as undefined', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({
          cloneUrl: 'https://github.com/test/ws-repo.git',
          targetDir: '   ',
        }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(202);
      expect(data.success).toBe(true);

      // Verify default path was used (basePath + repoName)
      const job = getCloneJob(mockDb, data.jobId);
      expect(job?.targetPath).toBe('/test/clone-root/ws-repo');
    });

    it('R-003: rejects targetDir longer than 1024 characters', async () => {
      const request = new NextRequest('http://localhost/api/repositories/clone', {
        method: 'POST',
        body: JSON.stringify({
          cloneUrl: 'https://github.com/test/long-repo.git',
          targetDir: 'a'.repeat(1025),
        }),
      });

      const response = await postClone(request);
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(data.error.code).toBe('INVALID_TARGET_PATH');
    });
  });

  describe('GET /api/repositories/clone/[jobId]', () => {
    it('should return 404 for non-existent job', async () => {
      const request = new NextRequest(
        'http://localhost/api/repositories/clone/non-existent-id',
        { method: 'GET' }
      );

      const response = await getCloneStatus(request, {
        params: Promise.resolve({ jobId: 'non-existent-id' }),
      });
      const data = await response.json();

      expect(response.status).toBe(404);
      expect(data.success).toBe(false);
      expect(data.error).toBe('Clone job not found');
    });

    it('should return pending job status', async () => {
      const job = createCloneJob(mockDb, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const request = new NextRequest(
        `http://localhost/api/repositories/clone/${job.id}`,
        { method: 'GET' }
      );

      const response = await getCloneStatus(request, {
        params: Promise.resolve({ jobId: job.id }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(data.jobId).toBe(job.id);
      expect(data.status).toBe('pending');
      expect(data.progress).toBe(0);
    });

    it('should return running job status with progress', async () => {
      const job = createCloneJob(mockDb, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(mockDb, job.id, {
        status: 'running',
        progress: 42,
        pid: 12345,
      });

      const request = new NextRequest(
        `http://localhost/api/repositories/clone/${job.id}`,
        { method: 'GET' }
      );

      const response = await getCloneStatus(request, {
        params: Promise.resolve({ jobId: job.id }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('running');
      expect(data.progress).toBe(42);
    });

    it('should return completed job status with repository ID', async () => {
      // Create repository first
      const repo = createRepository(mockDb, {
        name: 'cloned-repo',
        path: '/path/to/clone',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      const job = createCloneJob(mockDb, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(mockDb, job.id, {
        status: 'completed',
        progress: 100,
        repositoryId: repo.id,
      });

      const request = new NextRequest(
        `http://localhost/api/repositories/clone/${job.id}`,
        { method: 'GET' }
      );

      const response = await getCloneStatus(request, {
        params: Promise.resolve({ jobId: job.id }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('completed');
      expect(data.progress).toBe(100);
      expect(data.repositoryId).toBe(repo.id);
    });

    it('should return failed job status with error details', async () => {
      const job = createCloneJob(mockDb, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(mockDb, job.id, {
        status: 'failed',
        errorCategory: 'auth',
        errorCode: 'AUTH_FAILED',
        errorMessage: 'Authentication failed',
      });

      const request = new NextRequest(
        `http://localhost/api/repositories/clone/${job.id}`,
        { method: 'GET' }
      );

      const response = await getCloneStatus(request, {
        params: Promise.resolve({ jobId: job.id }),
      });
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.status).toBe('failed');
      expect(data.error).toBeDefined();
      expect(data.error.category).toBe('auth');
      expect(data.error.code).toBe('AUTH_FAILED');
      expect(data.error.message).toBe('Authentication failed');
    });
  });
});
