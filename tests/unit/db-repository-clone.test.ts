/**
 * Unit Tests: Repository and Clone Job DB Operations
 * Issue #71: Clone URL registration feature
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db-migrations';
import {
  createRepository,
  getRepositoryByNormalizedUrl,
  getRepositoryById,
  getRepositoryByPath,
  updateRepository,
  createCloneJob,
  updateCloneJob,
  getCloneJob,
  getActiveCloneJobByUrl,
  getCloneJobsByStatus,
} from '@/lib/db-repository';
import type { CloneJobStatus } from '@/types/clone';

describe('Repository DB Operations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createRepository', () => {
    it('should create a new repository', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneUrl: 'https://github.com/test/repo',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      expect(repo.id).toBeDefined();
      expect(repo.name).toBe('test-repo');
      expect(repo.path).toBe('/path/to/test-repo');
      expect(repo.cloneUrl).toBe('https://github.com/test/repo');
      expect(repo.normalizedCloneUrl).toBe('https://github.com/test/repo');
      expect(repo.cloneSource).toBe('https');
      expect(repo.enabled).toBe(true);
      expect(repo.isEnvManaged).toBe(false);
      expect(repo.createdAt).toBeInstanceOf(Date);
      expect(repo.updatedAt).toBeInstanceOf(Date);
    });

    it('should create a local repository without clone URL', () => {
      const repo = createRepository(db, {
        name: 'local-repo',
        path: '/path/to/local-repo',
        cloneSource: 'local',
      });

      expect(repo.id).toBeDefined();
      expect(repo.cloneUrl).toBeUndefined();
      expect(repo.normalizedCloneUrl).toBeUndefined();
      expect(repo.cloneSource).toBe('local');
    });

    it('should create an env-managed repository', () => {
      const repo = createRepository(db, {
        name: 'env-repo',
        path: '/path/to/env-repo',
        cloneSource: 'local',
        isEnvManaged: true,
      });

      expect(repo.isEnvManaged).toBe(true);
    });

    it('should throw error for duplicate path', () => {
      createRepository(db, {
        name: 'repo1',
        path: '/path/to/repo',
        cloneSource: 'local',
      });

      expect(() => {
        createRepository(db, {
          name: 'repo2',
          path: '/path/to/repo',
          cloneSource: 'local',
        });
      }).toThrow();
    });

    it('should throw error for duplicate normalized clone URL', () => {
      createRepository(db, {
        name: 'repo1',
        path: '/path/to/repo1',
        cloneUrl: 'https://github.com/test/repo',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      expect(() => {
        createRepository(db, {
          name: 'repo2',
          path: '/path/to/repo2',
          cloneUrl: 'git@github.com:test/repo.git',
          normalizedCloneUrl: 'https://github.com/test/repo',
          cloneSource: 'ssh',
        });
      }).toThrow();
    });
  });

  describe('getRepositoryByNormalizedUrl', () => {
    it('should find repository by normalized URL', () => {
      const created = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      const found = getRepositoryByNormalizedUrl(db, 'https://github.com/test/repo');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe('test-repo');
    });

    it('should return null for non-existent URL', () => {
      const found = getRepositoryByNormalizedUrl(db, 'https://github.com/nonexistent/repo');
      expect(found).toBeNull();
    });
  });

  describe('getRepositoryById', () => {
    it('should find repository by ID', () => {
      const created = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      const found = getRepositoryById(db, created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.name).toBe('test-repo');
    });

    it('should return null for non-existent ID', () => {
      const found = getRepositoryById(db, 'non-existent-id');
      expect(found).toBeNull();
    });
  });

  describe('getRepositoryByPath', () => {
    it('should find repository by path', () => {
      const created = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      const found = getRepositoryByPath(db, '/path/to/test-repo');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    it('should return null for non-existent path', () => {
      const found = getRepositoryByPath(db, '/nonexistent/path');
      expect(found).toBeNull();
    });
  });

  describe('updateRepository', () => {
    it('should update repository enabled status', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/test-repo',
        cloneSource: 'local',
      });

      updateRepository(db, repo.id, { enabled: false });

      const updated = getRepositoryById(db, repo.id);
      expect(updated!.enabled).toBe(false);
    });

    it('should update repository name', () => {
      const repo = createRepository(db, {
        name: 'old-name',
        path: '/path/to/repo',
        cloneSource: 'local',
      });

      updateRepository(db, repo.id, { name: 'new-name' });

      const updated = getRepositoryById(db, repo.id);
      expect(updated!.name).toBe('new-name');
    });
  });
});

describe('Clone Job DB Operations', () => {
  let db: Database.Database;

  beforeEach(() => {
    db = new Database(':memory:');
    runMigrations(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('createCloneJob', () => {
    it('should create a new clone job', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      expect(job.id).toBeDefined();
      expect(job.cloneUrl).toBe('https://github.com/test/repo.git');
      expect(job.normalizedCloneUrl).toBe('https://github.com/test/repo');
      expect(job.targetPath).toBe('/path/to/clone');
      expect(job.status).toBe('pending');
      expect(job.progress).toBe(0);
      expect(job.createdAt).toBeInstanceOf(Date);
    });
  });

  describe('getCloneJob', () => {
    it('should get clone job by ID', () => {
      const created = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      const found = getCloneJob(db, created.id);

      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
      expect(found!.cloneUrl).toBe('https://github.com/test/repo.git');
    });

    it('should return null for non-existent job', () => {
      const found = getCloneJob(db, 'non-existent-id');
      expect(found).toBeNull();
    });
  });

  describe('updateCloneJob', () => {
    it('should update job status to running', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, {
        status: 'running',
        pid: 12345,
        startedAt: new Date(),
      });

      const updated = getCloneJob(db, job.id);
      expect(updated!.status).toBe('running');
      expect(updated!.pid).toBe(12345);
      expect(updated!.startedAt).toBeInstanceOf(Date);
    });

    it('should update job status to completed', () => {
      const repo = createRepository(db, {
        name: 'test-repo',
        path: '/path/to/clone',
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        cloneSource: 'https',
      });

      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, {
        status: 'completed',
        progress: 100,
        repositoryId: repo.id,
        completedAt: new Date(),
      });

      const updated = getCloneJob(db, job.id);
      expect(updated!.status).toBe('completed');
      expect(updated!.progress).toBe(100);
      expect(updated!.repositoryId).toBe(repo.id);
      expect(updated!.completedAt).toBeInstanceOf(Date);
    });

    it('should update job status to failed with error', () => {
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
        completedAt: new Date(),
      });

      const updated = getCloneJob(db, job.id);
      expect(updated!.status).toBe('failed');
      expect(updated!.errorCategory).toBe('auth');
      expect(updated!.errorCode).toBe('AUTH_FAILED');
      expect(updated!.errorMessage).toBe('Authentication failed');
    });

    it('should update job progress', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, { progress: 50 });

      const updated = getCloneJob(db, job.id);
      expect(updated!.progress).toBe(50);
    });
  });

  describe('getActiveCloneJobByUrl', () => {
    it('should find active job for normalized URL', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, { status: 'running' });

      const found = getActiveCloneJobByUrl(db, 'https://github.com/test/repo');

      expect(found).not.toBeNull();
      expect(found!.id).toBe(job.id);
    });

    it('should not find completed jobs', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, { status: 'completed' });

      const found = getActiveCloneJobByUrl(db, 'https://github.com/test/repo');

      expect(found).toBeNull();
    });

    it('should not find failed jobs', () => {
      const job = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo.git',
        normalizedCloneUrl: 'https://github.com/test/repo',
        targetPath: '/path/to/clone',
      });

      updateCloneJob(db, job.id, { status: 'failed' });

      const found = getActiveCloneJobByUrl(db, 'https://github.com/test/repo');

      expect(found).toBeNull();
    });
  });

  describe('getCloneJobsByStatus', () => {
    it('should get all jobs by status', () => {
      createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo1.git',
        normalizedCloneUrl: 'https://github.com/test/repo1',
        targetPath: '/path/to/clone1',
      });

      const job2 = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo2.git',
        normalizedCloneUrl: 'https://github.com/test/repo2',
        targetPath: '/path/to/clone2',
      });
      updateCloneJob(db, job2.id, { status: 'running' });

      const job3 = createCloneJob(db, {
        cloneUrl: 'https://github.com/test/repo3.git',
        normalizedCloneUrl: 'https://github.com/test/repo3',
        targetPath: '/path/to/clone3',
      });
      updateCloneJob(db, job3.id, { status: 'completed' });

      const pendingJobs = getCloneJobsByStatus(db, 'pending');
      const runningJobs = getCloneJobsByStatus(db, 'running');
      const completedJobs = getCloneJobsByStatus(db, 'completed');

      expect(pendingJobs).toHaveLength(1);
      expect(runningJobs).toHaveLength(1);
      expect(completedJobs).toHaveLength(1);
    });

    it('should return empty array when no jobs with status', () => {
      const jobs = getCloneJobsByStatus(db, 'running');
      expect(jobs).toHaveLength(0);
    });
  });
});
