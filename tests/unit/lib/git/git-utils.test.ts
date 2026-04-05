/**
 * Tests for git-utils.ts commit log functions
 * Issue #627: Commit log in report
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they are available in vi.mock() factories
const { mockExistsSync, mockExecFileAsync } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock fs
vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

// Mock child_process + util together because git-utils uses promisify(execFile)
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import { getCommitsByDateRange, collectRepositoryCommitLogs } from '@/lib/git/git-utils';

describe('getCommitsByDateRange (Issue #627)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when path does not exist', async () => {
    mockExistsSync.mockReturnValue(false);

    const result = await getCommitsByDateRange('/nonexistent', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toEqual([]);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('should parse git log output correctly', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({
      stdout: 'abc1234\x1fFix bug in parser\x1fJohn Doe\ndef5678\x1fAdd new feature\x1fJane Smith\n',
    });

    const result = await getCommitsByDateRange('/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toEqual([
      { shortHash: 'abc1234', message: 'Fix bug in parser', author: 'John Doe' },
      { shortHash: 'def5678', message: 'Add new feature', author: 'Jane Smith' },
    ]);
  });

  it('should return empty array when git log returns empty output', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    const result = await getCommitsByDateRange('/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toEqual([]);
  });

  it('should return empty array when git log returns only whitespace', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({ stdout: '   \n  \n' });

    const result = await getCommitsByDateRange('/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toEqual([]);
  });

  it('should skip lines with incorrect field count', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({
      stdout: 'abc1234\x1fFix bug\x1fJohn\nbadline\ndef5678\x1fAdd feature\x1fJane\n',
    });

    const result = await getCommitsByDateRange('/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toHaveLength(2);
    expect(result[0].shortHash).toBe('abc1234');
    expect(result[1].shortHash).toBe('def5678');
  });

  it('should return empty array on execFile error', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockRejectedValue(new Error('git command failed'));

    const result = await getCommitsByDateRange('/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result).toEqual([]);
  });

  it('should pass correct arguments to execFile', async () => {
    mockExistsSync.mockReturnValue(true);
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await getCommitsByDateRange('/my/repo', '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      expect.arrayContaining(['log', '--all', '--since=2026-04-05T00:00:00Z', '--until=2026-04-05T23:59:59Z']),
      expect.objectContaining({
        cwd: '/my/repo',
        timeout: 5000,
      })
    );
  });
});

describe('collectRepositoryCommitLogs (Issue #627)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
  });

  it('should collect commits from multiple repositories', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc1234\x1fFix bug\x1fJohn\n' })
      .mockResolvedValueOnce({ stdout: 'def5678\x1fAdd feature\x1fJane\n' });

    const repos = [
      { id: 'repo-1', name: 'Repo One', path: '/repo1' },
      { id: 'repo-2', name: 'Repo Two', path: '/repo2' },
    ];

    const result = await collectRepositoryCommitLogs(repos, '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result.size).toBe(2);
    expect(result.get('repo-1')).toEqual({
      name: 'Repo One',
      commits: [{ shortHash: 'abc1234', message: 'Fix bug', author: 'John' }],
    });
    expect(result.get('repo-2')).toEqual({
      name: 'Repo Two',
      commits: [{ shortHash: 'def5678', message: 'Add feature', author: 'Jane' }],
    });
  });

  it('should skip repositories with no commits', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc1234\x1fFix bug\x1fJohn\n' })
      .mockResolvedValueOnce({ stdout: '' });

    const repos = [
      { id: 'repo-1', name: 'Repo One', path: '/repo1' },
      { id: 'repo-2', name: 'Repo Two', path: '/repo2' },
    ];

    const result = await collectRepositoryCommitLogs(repos, '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result.size).toBe(1);
    expect(result.has('repo-1')).toBe(true);
    expect(result.has('repo-2')).toBe(false);
  });

  it('should handle empty repositories array', async () => {
    const result = await collectRepositoryCommitLogs([], '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result.size).toBe(0);
  });

  it('should handle repositories where git fails gracefully', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'abc1234\x1fFix bug\x1fJohn\n' })
      .mockRejectedValueOnce(new Error('not a git repo'));

    const repos = [
      { id: 'repo-1', name: 'Repo One', path: '/repo1' },
      { id: 'repo-2', name: 'Bad Repo', path: '/bad' },
    ];

    const result = await collectRepositoryCommitLogs(repos, '2026-04-05T00:00:00Z', '2026-04-05T23:59:59Z');

    expect(result.size).toBe(1);
    expect(result.has('repo-1')).toBe(true);
  });
});
