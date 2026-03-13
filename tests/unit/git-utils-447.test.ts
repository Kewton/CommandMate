/**
 * Unit tests for git-utils.ts extensions
 * Issue #447: Git tab - commit history & diff display
 *
 * Tests getGitLog, getGitShow, getGitDiff functions
 * and GitTimeoutError, GitNotRepoError error classes
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CommitInfo } from '@/types/git';

// Mock child_process before importing
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

vi.mock('util', () => ({
  promisify: (fn: unknown) => fn,
}));

describe('git-utils Issue #447', () => {
  let execFileMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const cp = await import('child_process');
    execFileMock = cp.execFile as unknown as ReturnType<typeof vi.fn>;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('GIT_LOG_TIMEOUT_MS', () => {
    it('should export GIT_LOG_TIMEOUT_MS as 3000', async () => {
      const { GIT_LOG_TIMEOUT_MS } = await import('@/lib/git/git-utils');
      expect(GIT_LOG_TIMEOUT_MS).toBe(3000);
    });
  });

  describe('GitTimeoutError', () => {
    it('should be instance of Error with name GitTimeoutError', async () => {
      const { GitTimeoutError } = await import('@/lib/git/git-utils');
      const err = new GitTimeoutError('timed out');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GitTimeoutError');
      expect(err.message).toBe('timed out');
    });
  });

  describe('GitNotRepoError', () => {
    it('should be instance of Error with name GitNotRepoError', async () => {
      const { GitNotRepoError } = await import('@/lib/git/git-utils');
      const err = new GitNotRepoError('not a repo');
      expect(err).toBeInstanceOf(Error);
      expect(err.name).toBe('GitNotRepoError');
      expect(err.message).toBe('not a repo');
    });
  });

  describe('getGitLog', () => {
    it('should parse git log output into CommitInfo array', async () => {
      const mockOutput = [
        'abc123def456abc123def456abc123def456abc12345',
        'abc123d',
        'feat: add new feature',
        'John Doe',
        '2026-03-08T10:00:00+09:00',
        'def456abc123def456abc123def456abc123def45678',
        'def456a',
        'fix: resolve bug',
        'Jane Smith',
        '2026-03-07T09:00:00+09:00',
      ].join('\n');

      execFileMock.mockResolvedValue({ stdout: mockOutput, stderr: '' });

      const { getGitLog } = await import('@/lib/git/git-utils');
      const result = await getGitLog('/path/to/worktree');

      expect(result).toHaveLength(2);
      expect(result[0]).toEqual({
        hash: 'abc123def456abc123def456abc123def456abc12345',
        shortHash: 'abc123d',
        message: 'feat: add new feature',
        author: 'John Doe',
        date: '2026-03-08T10:00:00+09:00',
      });
      expect(result[1].message).toBe('fix: resolve bug');
    });

    it('should return empty array for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

      const { getGitLog } = await import('@/lib/git/git-utils');
      const result = await getGitLog('/path/to/worktree');

      expect(result).toEqual([]);
    });

    it('should pass limit and offset to git command', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

      const { getGitLog } = await import('@/lib/git/git-utils');
      await getGitLog('/path/to/worktree', 10, 5);

      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['log', '--max-count=10', '--skip=5', '--format=%H%n%h%n%s%n%an%n%aI', '--'],
        expect.objectContaining({
          cwd: '/path/to/worktree',
          timeout: 3000,
        })
      );
    });

    it('should throw GitTimeoutError on timeout', async () => {
      const timeoutError = new Error('timed out');
      (timeoutError as Error & { killed?: boolean }).killed = true;
      execFileMock.mockRejectedValue(timeoutError);

      const { getGitLog, GitTimeoutError } = await import('@/lib/git/git-utils');

      await expect(getGitLog('/path/to/worktree')).rejects.toThrow(GitTimeoutError);
    });

    it('should throw GitNotRepoError when not a git repository', async () => {
      const notRepoError = new Error('fatal: not a git repository');
      (notRepoError as Error & { stderr?: string }).stderr = 'fatal: not a git repository';
      execFileMock.mockRejectedValue(notRepoError);

      const { getGitLog, GitNotRepoError } = await import('@/lib/git/git-utils');

      await expect(getGitLog('/path/to/worktree')).rejects.toThrow(GitNotRepoError);
    });
  });

  describe('getGitShow', () => {
    it('should parse commit info and changed files using diff-tree', async () => {
      const mockLogOutput = [
        'abc123def456abc123def456abc123def456abc12345',
        'abc123d',
        'feat: add new feature',
        'John Doe',
        '2026-03-08T10:00:00+09:00',
      ].join('\n');

      const mockDiffTreeOutput = [
        'A\tsrc/lib/new-file.ts',
        'M\tsrc/lib/old-file.ts',
      ].join('\n');

      // First call: git log, Second call: git diff-tree
      execFileMock
        .mockResolvedValueOnce({ stdout: mockLogOutput, stderr: '' })
        .mockResolvedValueOnce({ stdout: mockDiffTreeOutput, stderr: '' });

      const { getGitShow } = await import('@/lib/git/git-utils');
      const result = await getGitShow('/path/to/worktree', 'abc123d');

      expect(result).not.toBeNull();
      expect(result!.commit.hash).toBe('abc123def456abc123def456abc123def456abc12345');
      expect(result!.commit.message).toBe('feat: add new feature');
      expect(result!.files).toHaveLength(2);
      expect(result!.files[0].path).toBe('src/lib/new-file.ts');
      expect(result!.files[0].status).toBe('added');
      expect(result!.files[1].path).toBe('src/lib/old-file.ts');
      expect(result!.files[1].status).toBe('modified');
    });

    it('should handle renamed and deleted files', async () => {
      const mockLogOutput = [
        'abc123def456abc123def456abc123def456abc12345',
        'abc123d',
        'refactor: rename files',
        'John Doe',
        '2026-03-08T10:00:00+09:00',
      ].join('\n');

      const mockDiffTreeOutput = [
        'R100\tsrc/old-name.ts\tsrc/new-name.ts',
        'D\tsrc/removed.ts',
      ].join('\n');

      execFileMock
        .mockResolvedValueOnce({ stdout: mockLogOutput, stderr: '' })
        .mockResolvedValueOnce({ stdout: mockDiffTreeOutput, stderr: '' });

      const { getGitShow } = await import('@/lib/git/git-utils');
      const result = await getGitShow('/path/to/worktree', 'abc123d');

      expect(result).not.toBeNull();
      expect(result!.files).toHaveLength(2);
      expect(result!.files[0].status).toBe('renamed');
      expect(result!.files[0].path).toBe('src/new-name.ts');
      expect(result!.files[1].status).toBe('deleted');
      expect(result!.files[1].path).toBe('src/removed.ts');
    });

    it('should return null for unknown commit', async () => {
      const error = new Error('unknown revision');
      execFileMock.mockRejectedValue(error);

      const { getGitShow } = await import('@/lib/git/git-utils');
      const result = await getGitShow('/path/to/worktree', 'deadbeef');

      expect(result).toBeNull();
    });

    it('should throw GitTimeoutError on timeout', async () => {
      const timeoutError = new Error('timed out');
      (timeoutError as Error & { killed?: boolean }).killed = true;
      execFileMock.mockRejectedValue(timeoutError);

      const { getGitShow, GitTimeoutError } = await import('@/lib/git/git-utils');

      await expect(getGitShow('/path/to/worktree', 'abc123d')).rejects.toThrow(GitTimeoutError);
    });
  });

  describe('getGitDiff', () => {
    it('should return diff content', async () => {
      const mockDiff = [
        'diff --git a/src/file.ts b/src/file.ts',
        '--- a/src/file.ts',
        '+++ b/src/file.ts',
        '@@ -1,3 +1,4 @@',
        ' line1',
        '+newline',
        ' line2',
        ' line3',
      ].join('\n');

      execFileMock.mockResolvedValue({ stdout: mockDiff, stderr: '' });

      const { getGitDiff } = await import('@/lib/git/git-utils');
      const result = await getGitDiff('/path/to/worktree', 'abc123d', 'src/file.ts');

      expect(result).toBe(mockDiff);
    });

    it('should return null for empty output', async () => {
      execFileMock.mockResolvedValue({ stdout: '', stderr: '' });

      const { getGitDiff } = await import('@/lib/git/git-utils');
      const result = await getGitDiff('/path/to/worktree', 'abc123d', 'nonexistent.ts');

      expect(result).toBeNull();
    });

    it('should pass file path with -- separator', async () => {
      execFileMock.mockResolvedValue({ stdout: 'diff output', stderr: '' });

      const { getGitDiff } = await import('@/lib/git/git-utils');
      await getGitDiff('/path/to/worktree', 'abc123d', 'src/file.ts');

      expect(execFileMock).toHaveBeenCalledWith(
        'git',
        ['show', 'abc123d', '--', 'src/file.ts'],
        expect.objectContaining({
          cwd: '/path/to/worktree',
          timeout: 3000,
        })
      );
    });

    it('should throw GitTimeoutError on timeout', async () => {
      const timeoutError = new Error('timed out');
      (timeoutError as Error & { killed?: boolean }).killed = true;
      execFileMock.mockRejectedValue(timeoutError);

      const { getGitDiff, GitTimeoutError } = await import('@/lib/git/git-utils');

      await expect(getGitDiff('/path/to/worktree', 'abc123d', 'file.ts')).rejects.toThrow(GitTimeoutError);
    });

    it('should return null on general error', async () => {
      execFileMock.mockRejectedValue(new Error('some error'));

      const { getGitDiff } = await import('@/lib/git/git-utils');
      const result = await getGitDiff('/path/to/worktree', 'abc123d', 'file.ts');

      expect(result).toBeNull();
    });
  });

  describe('CommitInfo type', () => {
    it('should have all required fields', () => {
      const commit: CommitInfo = {
        hash: 'abc123',
        shortHash: 'abc12',
        message: 'test',
        author: 'author',
        date: '2026-03-08T00:00:00Z',
      };

      expect(commit).toHaveProperty('hash');
      expect(commit).toHaveProperty('shortHash');
      expect(commit).toHaveProperty('message');
      expect(commit).toHaveProperty('author');
      expect(commit).toHaveProperty('date');
    });
  });
});
