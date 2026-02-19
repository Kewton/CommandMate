/**
 * Unit Tests: CloneManager
 * Issue #71: Clone URL registration feature
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import { CloneManager, CloneManagerError, resetWorktreeBasePathWarning } from '@/lib/clone-manager';
import {
  createRepository,
  getCloneJob,
  createCloneJob,
  updateCloneJob,
} from '@/lib/db-repository';

// Mock child_process
vi.mock('child_process', () => ({
  spawn: vi.fn(),
  exec: vi.fn(),
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

describe('CloneManager', () => {
  let db: Database.Database;
  let cloneManager: CloneManager;

  beforeEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    resetWorktreeBasePathWarning();
    db = new Database(':memory:');
    runMigrations(db);
    cloneManager = new CloneManager(db, { basePath: '/tmp/repos' });
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  describe('validateCloneRequest', () => {
    it('should validate a valid HTTPS URL', () => {
      const result = cloneManager.validateCloneRequest('https://github.com/test/repo.git');

      expect(result.valid).toBe(true);
      expect(result.normalizedUrl).toBe('https://github.com/test/repo');
      expect(result.repoName).toBe('repo');
    });

    it('should validate a valid SSH URL', () => {
      const result = cloneManager.validateCloneRequest('git@github.com:test/repo.git');

      expect(result.valid).toBe(true);
      expect(result.normalizedUrl).toBe('https://github.com/test/repo');
      expect(result.repoName).toBe('repo');
    });

    it('should reject invalid URL', () => {
      const result = cloneManager.validateCloneRequest('not-a-url');

      expect(result.valid).toBe(false);
      expect(result.error).toBeDefined();
      expect(result.error?.code).toBe('INVALID_URL_FORMAT');
    });

    it('should reject empty URL', () => {
      const result = cloneManager.validateCloneRequest('');

      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe('EMPTY_URL');
    });
  });

  describe('checkDuplicateRepository', () => {
    it('should return null for non-duplicate URL', () => {
      const result = cloneManager.checkDuplicateRepository('https://github.com/test/repo');

      expect(result).toBeNull();
    });

    it('should return existing repository for duplicate URL', () => {
      createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      const result = cloneManager.checkDuplicateRepository('https://github.com/test/repo');

      expect(result).not.toBeNull();
      expect(result?.name).toBe('test-repo');
    });
  });

  describe('checkActiveCloneJob', () => {
    it('should return null when no active job exists', () => {
      const result = cloneManager.checkActiveCloneJob('https://github.com/test/repo');

      expect(result).toBeNull();
    });

    it('should return active job for URL', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const result = cloneManager.checkActiveCloneJob('https://github.com/test/repo');

      expect(result).not.toBeNull();
      expect(result?.id).toBe(job.id);
    });

    it('should not return completed job', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });
      updateCloneJob(db, job.id, { status: 'completed' });

      const result = cloneManager.checkActiveCloneJob('https://github.com/test/repo');

      expect(result).toBeNull();
    });
  });

  describe('createCloneJob', () => {
    it('should create a new clone job', () => {
      const result = cloneManager.createCloneJob({
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      expect(result.id).toBeDefined();
      expect(result.status).toBe('pending');

      // Verify in database
      const job = getCloneJob(db, result.id);
      expect(job).not.toBeNull();
      expect(job?.cloneUrl).toBe('https://github.com/test/repo.git');
    });
  });

  describe('startCloneJob', () => {
    it('should reject invalid URL', async () => {
      const result = await cloneManager.startCloneJob('not-a-url');

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('validation');
      expect(result.error?.code).toBe('INVALID_URL_FORMAT');
    });

    it('should reject duplicate repository', async () => {
      createRepository(db, {
        name: 'existing-repo',
        path: '/path/to/existing-repo',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      const result = await cloneManager.startCloneJob('https://github.com/test/repo.git');

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('validation');
      expect(result.error?.code).toBe('DUPLICATE_CLONE_URL');
    });

    it('should reject when clone job already active', async () => {
      createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const result = await cloneManager.startCloneJob('https://github.com/test/repo.git');

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('validation');
      expect(result.error?.code).toBe('CLONE_IN_PROGRESS');
    });

    it('should reject when target directory already exists', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValueOnce(true);

      const result = await cloneManager.startCloneJob('https://github.com/test/newrepo.git');

      expect(result.success).toBe(false);
      expect(result.error?.category).toBe('filesystem');
      expect(result.error?.code).toBe('DIRECTORY_EXISTS');
    });

    it('should use custom target path if provided (within basePath)', async () => {
      const { existsSync } = await import('fs');
      vi.mocked(existsSync).mockReturnValue(false);

      // Custom path must be within basePath (/tmp/repos)
      const customPath = '/tmp/repos/custom/target/path';
      const result = await cloneManager.startCloneJob(
        'https://github.com/test/custompath.git',
        customPath
      );

      expect(result.success).toBe(true);
      expect(result.jobId).toBeDefined();

      // Verify the job was created with custom path
      const job = getCloneJob(db, result.jobId!);
      expect(job?.targetPath).toBe(customPath);
    });

    it('should reject custom target path outside basePath (path traversal protection)', async () => {
      const result = await cloneManager.startCloneJob(
        'https://github.com/test/custompath.git',
        '/etc/passwd/../evil'
      );

      expect(result.success).toBe(false);
      expect(result.error?.code).toBe('INVALID_TARGET_PATH');
    });

    it('should return jobId for active clone when rejecting', async () => {
      const existingJob = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/activeclone.git',
        normalizedCloneUrl: 'https://github.com/test/activeclone',
        targetPath: '/path/to/clone',
      });

      const result = await cloneManager.startCloneJob('https://github.com/test/activeclone.git');

      expect(result.success).toBe(false);
      expect(result.jobId).toBe(existingJob.id);
    });
  });

  describe('getCloneJobStatus', () => {
    it('should return job status', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const status = cloneManager.getCloneJobStatus(job.id);

      expect(status).not.toBeNull();
      expect(status?.jobId).toBe(job.id);
      expect(status?.status).toBe('pending');
      expect(status?.progress).toBe(0);
    });

    it('should return null for non-existent job', () => {
      const status = cloneManager.getCloneJobStatus('non-existent-id');

      expect(status).toBeNull();
    });

    it('should include error details for failed job', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });
      updateCloneJob(db, job.id, {
        status: 'failed',
        errorCategory: 'auth',
        errorCode: 'AUTH_FAILED',
        errorMessage: 'Authentication failed',
      });

      const status = cloneManager.getCloneJobStatus(job.id);

      expect(status?.status).toBe('failed');
      expect(status?.error).toBeDefined();
      expect(status?.error?.category).toBe('auth');
      expect(status?.error?.code).toBe('AUTH_FAILED');
    });
  });

  describe('getTargetPath', () => {
    it('should generate target path from repo name', () => {
      const path = cloneManager.getTargetPath('my-repo');

      expect(path).toMatch(/my-repo$/);
    });

    it('should use custom base path if provided', () => {
      const manager = new CloneManager(db, { basePath: '/custom/base' });
      const path = manager.getTargetPath('my-repo');

      expect(path).toBe('/custom/base/my-repo');
    });
  });

  describe('cancelCloneJob', () => {
    it('should return false for non-existent job', () => {
      const result = cloneManager.cancelCloneJob('non-existent-id');

      expect(result).toBe(false);
    });

    it('should cancel pending job', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const result = cloneManager.cancelCloneJob(job.id);

      expect(result).toBe(true);

      // Verify job status changed
      const updated = getCloneJob(db, job.id);
      expect(updated?.status).toBe('cancelled');
    });

    it('should not cancel completed job', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });
      updateCloneJob(db, job.id, { status: 'completed' });

      const result = cloneManager.cancelCloneJob(job.id);

      expect(result).toBe(false);
    });
  });
});

describe('CloneManager - basePath resolution', () => {
  let db: Database.Database;

  beforeEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    resetWorktreeBasePathWarning();
    db = new Database(':memory:');
    runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    db.close();
  });

  it('should use config.basePath when explicitly provided', () => {
    const manager = new CloneManager(db, { basePath: '/custom/clone/root' });
    const targetPath = manager.getTargetPath('my-repo');

    expect(targetPath).toBe('/custom/clone/root/my-repo');
  });

  it('should use WORKTREE_BASE_PATH when config.basePath is not provided and emit deprecation warning', () => {
    process.env.WORKTREE_BASE_PATH = '/legacy/worktree/path';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new CloneManager(db);
    const targetPath = manager.getTargetPath('my-repo');

    expect(targetPath).toBe('/legacy/worktree/path/my-repo');
    expect(warnSpy).toHaveBeenCalledWith(
      '[DEPRECATED] WORKTREE_BASE_PATH is deprecated. Set CM_ROOT_DIR in your .env file instead.'
    );

    warnSpy.mockRestore();
  });

  it('should normalize WORKTREE_BASE_PATH with path.resolve() for relative paths (D1-007)', () => {
    process.env.WORKTREE_BASE_PATH = 'relative/path';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new CloneManager(db);
    const targetPath = manager.getTargetPath('my-repo');

    // path.resolve('relative/path') produces an absolute path
    expect(targetPath).toMatch(/^\/.*relative\/path\/my-repo$/);

    warnSpy.mockRestore();
  });

  it('should fall back to process.cwd() when neither config.basePath nor WORKTREE_BASE_PATH is set', () => {
    const cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue('/test/cwd/fallback');

    const manager = new CloneManager(db);
    const targetPath = manager.getTargetPath('my-repo');

    expect(targetPath).toBe('/test/cwd/fallback/my-repo');

    cwdSpy.mockRestore();
  });

  it('should emit deprecation warning only once across multiple instantiations', () => {
    process.env.WORKTREE_BASE_PATH = '/legacy/path';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // First instantiation - should warn
    new CloneManager(db);
    // Second instantiation - should NOT warn again
    new CloneManager(db);

    const deprecationWarnings = warnSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('[DEPRECATED]')
    );
    expect(deprecationWarnings).toHaveLength(1);

    warnSpy.mockRestore();
  });

  it('should prefer config.basePath (CM_ROOT_DIR) over WORKTREE_BASE_PATH when both are available', () => {
    process.env.WORKTREE_BASE_PATH = '/legacy/worktree/path';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const manager = new CloneManager(db, { basePath: '/cm/root/dir' });
    const targetPath = manager.getTargetPath('my-repo');

    expect(targetPath).toBe('/cm/root/dir/my-repo');
    // Should not emit deprecation warning because config.basePath takes priority
    expect(warnSpy).not.toHaveBeenCalled();

    warnSpy.mockRestore();
  });
});

describe('CloneManager - security (D4-001)', () => {
  let db: Database.Database;

  beforeEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    resetWorktreeBasePathWarning();
    db = new Database(':memory:');
    runMigrations(db);
    vi.clearAllMocks();
  });

  afterEach(() => {
    db.close();
  });

  it('should not include basePath value in path traversal error message', async () => {
    const secretBasePath = '/secret/internal/path';
    const manager = new CloneManager(db, { basePath: secretBasePath });

    const result = await manager.startCloneJob(
      'https://github.com/test/repo.git',
      '/etc/evil/path'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('INVALID_TARGET_PATH');
    // The error message must NOT contain the basePath value
    expect(result.error?.message).not.toContain(secretBasePath);
  });

  it('should not include full targetPath in directory exists error message', async () => {
    const { existsSync } = await import('fs');
    vi.mocked(existsSync).mockReturnValue(true);

    const manager = new CloneManager(db, { basePath: '/test/base' });

    const result = await manager.startCloneJob(
      'https://github.com/test/newrepo.git'
    );

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('DIRECTORY_EXISTS');
    // The error message must NOT contain the full internal path
    expect(result.error?.message).not.toContain('/test/base/newrepo');
  });
});

describe('CloneManagerError', () => {
  it('should create error with all properties', () => {
    const error = new CloneManagerError({
      category: 'auth',
      code: 'AUTH_FAILED',
      message: 'Authentication failed',
      recoverable: true,
      suggestedAction: 'Check your credentials',
    });

    expect(error.category).toBe('auth');
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toBe('Authentication failed');
    expect(error.recoverable).toBe(true);
    expect(error.suggestedAction).toBe('Check your credentials');
  });

  it('should be instance of Error', () => {
    const error = new CloneManagerError({
      category: 'system',
      code: 'UNKNOWN',
      message: 'Unknown error',
      recoverable: false,
      suggestedAction: 'Contact support',
    });

    expect(error).toBeInstanceOf(Error);
  });
});

describe('CloneManager - parseGitProgress', () => {
  let db: Database.Database;
  let cloneManager: CloneManager;

  beforeEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    resetWorktreeBasePathWarning();
    db = new Database(':memory:');
    runMigrations(db);
    cloneManager = new CloneManager(db, { basePath: '/tmp/repos' });
  });

  afterEach(() => {
    db.close();
  });

  it('should parse "Receiving objects" progress', () => {
    const output = 'Receiving objects:  42% (123/456), 1.23 MiB | 2.34 MiB/s';
    const progress = cloneManager.parseGitProgress(output);
    expect(progress).toBe(42);
  });

  it('should parse "Resolving deltas" progress', () => {
    const output = 'Resolving deltas:  75% (100/133)';
    const progress = cloneManager.parseGitProgress(output);
    expect(progress).toBe(75);
  });

  it('should return null for non-progress output', () => {
    const output = 'Cloning into some-repo...';
    const progress = cloneManager.parseGitProgress(output);
    expect(progress).toBeNull();
  });

  it('should return null for empty output', () => {
    const progress = cloneManager.parseGitProgress('');
    expect(progress).toBeNull();
  });
});

describe('CloneManager - parseGitError', () => {
  let db: Database.Database;
  let cloneManager: CloneManager;

  beforeEach(() => {
    delete process.env.WORKTREE_BASE_PATH;
    resetWorktreeBasePathWarning();
    db = new Database(':memory:');
    runMigrations(db);
    cloneManager = new CloneManager(db, { basePath: '/tmp/repos' });
  });

  afterEach(() => {
    db.close();
  });

  it('should detect authentication failed error', () => {
    const stderr = 'fatal: Authentication failed for https://github.com/repo.git';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('auth');
    expect(error.code).toBe('AUTH_FAILED');
    expect(error.message).toContain('Authentication failed');
  });

  it('should detect permission denied error', () => {
    const stderr = 'Permission denied (publickey).';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('auth');
    expect(error.code).toBe('AUTH_FAILED');
  });

  it('should detect could not read from remote repository error', () => {
    const stderr = 'fatal: Could not read from remote repository.';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('auth');
    expect(error.code).toBe('AUTH_FAILED');
  });

  it('should detect could not resolve host error', () => {
    const stderr = 'fatal: unable to access: Could not resolve host: github.com';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('network');
    expect(error.code).toBe('NETWORK_ERROR');
    expect(error.message).toContain('Network error');
  });

  it('should detect connection refused error', () => {
    const stderr = 'fatal: Connection refused';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('network');
    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('should detect network is unreachable error', () => {
    const stderr = 'fatal: Network is unreachable';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('network');
    expect(error.code).toBe('NETWORK_ERROR');
  });

  it('should return generic git error for unknown errors', () => {
    const stderr = 'fatal: repository not found';
    const error = cloneManager.parseGitError(stderr, 128);

    expect(error.category).toBe('git');
    expect(error.code).toBe('GIT_ERROR');
    expect(error.message).toContain('exit code 128');
  });

  it('should truncate long error messages', () => {
    const longStderr = 'x'.repeat(500);
    const error = cloneManager.parseGitError(longStderr, 1);

    expect(error.message.length).toBeLessThan(300);
  });
});
