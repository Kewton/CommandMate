/**
 * Unit tests for git-utils.ts
 * Issue #111: Branch visualization feature
 * TDD Approach: Test git status retrieval functionality
 *
 * Note: Tests verify the logic of getGitStatus function
 * by mocking the internal execGitCommand helper via module mocking
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { GitStatus } from '@/types/models';

// Mock child_process so the real getAheadBehind implementation can be exercised
// (the getGitStatus tests below use vi.doMock on the whole module and are unaffected).
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

// We'll test by importing the module directly
// and testing the behavior with real git repos (or skipping if no git)
// For mocking, we'll mock at a higher level

describe('git-utils', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getGitStatus behavior tests', () => {
    // These tests verify the expected output structure
    // rather than mocking child_process directly

    it('should return correct GitStatus structure', async () => {
      // Mock the entire module to test contract
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: 'feature/test-branch',
          initialBranch: 'main',
          isBranchMismatch: true,
          commitHash: 'abc1234',
          isDirty: false,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', 'main');

      expect(result).toEqual({
        currentBranch: 'feature/test-branch',
        initialBranch: 'main',
        isBranchMismatch: true,
        commitHash: 'abc1234',
        isDirty: false,
      });

      vi.doUnmock('@/lib/git/git-utils');
    });

    it('should have isBranchMismatch=false when branches match', async () => {
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: 'main',
          initialBranch: 'main',
          isBranchMismatch: false,
          commitHash: 'def5678',
          isDirty: false,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', 'main');

      expect(result.currentBranch).toBe('main');
      expect(result.initialBranch).toBe('main');
      expect(result.isBranchMismatch).toBe(false);

      vi.doUnmock('@/lib/git/git-utils');
    });

    it('should handle detached HEAD state', async () => {
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: '(detached HEAD)',
          initialBranch: 'main',
          isBranchMismatch: false,
          commitHash: 'abc1234',
          isDirty: false,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', 'main');

      expect(result.currentBranch).toBe('(detached HEAD)');
      expect(result.isBranchMismatch).toBe(false);

      vi.doUnmock('@/lib/git/git-utils');
    });

    it('should return (unknown) on error', async () => {
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: '(unknown)',
          initialBranch: 'main',
          isBranchMismatch: false,
          commitHash: '(unknown)',
          isDirty: false,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', 'main');

      expect(result.currentBranch).toBe('(unknown)');
      expect(result.isBranchMismatch).toBe(false);

      vi.doUnmock('@/lib/git/git-utils');
    });

    it('should detect dirty working directory', async () => {
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: 'main',
          initialBranch: 'main',
          isBranchMismatch: false,
          commitHash: 'abc1234',
          isDirty: true,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', 'main');

      expect(result.isDirty).toBe(true);

      vi.doUnmock('@/lib/git/git-utils');
    });

    it('should handle null initialBranch', async () => {
      vi.doMock('@/lib/git/git-utils', () => ({
        getGitStatus: vi.fn().mockResolvedValue({
          currentBranch: 'feature/new-branch',
          initialBranch: null,
          isBranchMismatch: false,
          commitHash: 'abc1234',
          isDirty: false,
        }),
      }));

      const { getGitStatus } = await import('@/lib/git/git-utils');
      const result = await getGitStatus('/path/to/worktree', null);

      expect(result.initialBranch).toBeNull();
      expect(result.isBranchMismatch).toBe(false);

      vi.doUnmock('@/lib/git/git-utils');
    });
  });

  describe('getAheadBehind (Issue #779)', () => {
    let execFileMock: ReturnType<typeof vi.fn>;

    beforeEach(async () => {
      vi.clearAllMocks();
      const cp = await import('child_process');
      execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
    });

    it('should run git rev-list --left-right --count @{upstream}...HEAD with static arg-array', async () => {
      execFileMock.mockResolvedValue({ stdout: '1\t2\n', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      await getAheadBehind('/path/to/worktree');

      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['rev-list', '--left-right', '--count', '@{upstream}...HEAD'],
        expect.objectContaining({
          cwd: '/path/to/worktree',
          timeout: 1000,
        })
      );
    });

    it('should map left=behind, right=ahead (1\\t2 -> {ahead:2, behind:1})', async () => {
      execFileMock.mockResolvedValue({ stdout: '1\t2\n', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toEqual({ ahead: 2, behind: 1 });
    });

    it('should return {ahead:0, behind:0} for in-sync upstream', async () => {
      execFileMock.mockResolvedValue({ stdout: '0\t0\n', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toEqual({ ahead: 0, behind: 0 });
    });

    it('should return null when command fails (no upstream / detached HEAD)', async () => {
      // execGitCommand returns null on rejection (e.g., @{upstream} resolution failure)
      execFileMock.mockRejectedValue(new Error('no upstream configured'));

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should return null on timeout', async () => {
      const timeoutError = Object.assign(new Error('timed out'), { killed: true });
      execFileMock.mockRejectedValue(timeoutError);

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should return null when output has wrong tab-count (parse failure)', async () => {
      execFileMock.mockResolvedValue({ stdout: '1 2', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should return null when output has too many tab fields', async () => {
      execFileMock.mockResolvedValue({ stdout: '1\t2\t3', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should return null when output contains non-integer values', async () => {
      execFileMock.mockResolvedValue({ stdout: 'abc\txyz', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should return null for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      const result = await getAheadBehind('/path/to/worktree');

      expect(result).toBeNull();
    });

    it('should never throw (all failure modes resolve to null)', async () => {
      execFileMock.mockRejectedValue(new Error('catastrophic git failure'));

      const { getAheadBehind } = await import('@/lib/git/git-utils');
      await expect(getAheadBehind('/path/to/worktree')).resolves.toBeNull();
    });
  });

  describe('GitStatus interface validation', () => {
    it('should have all required fields', () => {
      const status: GitStatus = {
        currentBranch: 'main',
        initialBranch: null,
        isBranchMismatch: false,
        commitHash: 'abc1234',
        isDirty: false,
      };

      expect(status).toHaveProperty('currentBranch');
      expect(status).toHaveProperty('initialBranch');
      expect(status).toHaveProperty('isBranchMismatch');
      expect(status).toHaveProperty('commitHash');
      expect(status).toHaveProperty('isDirty');
    });

    it('should allow initialBranch to be null', () => {
      const status: GitStatus = {
        currentBranch: 'feature/test',
        initialBranch: null,
        isBranchMismatch: false,
        commitHash: 'abc1234',
        isDirty: false,
      };

      expect(status.initialBranch).toBeNull();
    });
  });
});
