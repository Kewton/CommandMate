/**
 * Tests for git-diff.ts (getWorkingTreeDiff working-tree per-file diff).
 * Issue #780 (originally in git-utils.test.ts).
 * Issue #921: split out of git-utils.test.ts to follow the new module boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they are available in vi.mock() factories
const { mockExistsSync, mockExecFileAsync, mockLogger } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));

vi.mock('@/lib/logger', () => {
  mockLogger.withContext.mockReturnValue(mockLogger);
  return {
    createLogger: vi.fn(() => mockLogger),
  };
});

vi.mock('fs', () => ({
  default: { existsSync: (...args: unknown[]) => mockExistsSync(...args) },
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import { getWorkingTreeDiff } from '@/lib/git/git-diff';
import { GitTimeoutError, GitNotRepoError } from '@/lib/git/git-errors';

// ============================================================================
// Issue #780: getWorkingTreeDiff (working-tree per-file diff)
// ============================================================================

describe('getWorkingTreeDiff (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run "git diff --cached -- <file>" for the staged mode', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'diff --git a/a.ts b/a.ts\n+staged\n' });

    const result = await getWorkingTreeDiff('/repo', 'src/a.ts', 'staged');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--cached', '--', 'src/a.ts'],
      expect.objectContaining({ cwd: '/repo', timeout: 3000 })
    );
    expect(result).toBe('diff --git a/a.ts b/a.ts\n+staged');
  });

  it('should run "git diff -- <file>" for the unstaged mode', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'diff --git a/b.ts b/b.ts\n-old\n+new\n' });

    const result = await getWorkingTreeDiff('/repo', 'src/b.ts', 'unstaged');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--', 'src/b.ts'],
      expect.objectContaining({ cwd: '/repo', timeout: 3000 })
    );
    expect(result).toBe('diff --git a/b.ts b/b.ts\n-old\n+new');
  });

  it('should run "git diff --no-index -- /dev/null <file>" for the untracked mode', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'diff --git a/new.ts b/new.ts\n+brand new\n' });

    const result = await getWorkingTreeDiff('/repo', 'src/new.ts', 'untracked');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['diff', '--no-index', '--', '/dev/null', 'src/new.ts'],
      expect.objectContaining({ cwd: '/repo', timeout: 3000 })
    );
    expect(result).toBe('diff --git a/new.ts b/new.ts\n+brand new');
  });

  it('should recover stdout when --no-index exits with code 1 (diff present)', async () => {
    // `git diff --no-index` exits non-zero (code 1) when there IS a diff, which
    // is the NORMAL case for an untracked file. execFile rejects, but the error
    // carries the diff on `stdout`. getWorkingTreeDiff must return that stdout.
    const err = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: 'diff --git a/new.ts b/new.ts\n+brand new\n',
      stderr: '',
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await getWorkingTreeDiff('/repo', 'src/new.ts', 'untracked');

    expect(result).toBe('diff --git a/new.ts b/new.ts\n+brand new');
  });

  it('should return null when there is no diff (empty stdout)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    const result = await getWorkingTreeDiff('/repo', 'src/clean.ts', 'unstaged');

    expect(result).toBeNull();
  });

  it('should return null when --no-index exits 1 with empty stdout (no diff)', async () => {
    const err = Object.assign(new Error('Command failed'), {
      code: 1,
      stdout: '   \n',
      stderr: '',
    });
    mockExecFileAsync.mockRejectedValue(err);

    const result = await getWorkingTreeDiff('/repo', 'src/new.ts', 'untracked');

    expect(result).toBeNull();
  });

  it('should re-throw GitTimeoutError on timeout (staged/unstaged)', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true });
    mockExecFileAsync.mockRejectedValue(err);

    await expect(getWorkingTreeDiff('/repo', 'src/a.ts', 'unstaged')).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it('should re-throw GitTimeoutError on timeout (untracked)', async () => {
    const err = Object.assign(new Error('timed out'), { killed: true });
    mockExecFileAsync.mockRejectedValue(err);

    await expect(getWorkingTreeDiff('/repo', 'src/new.ts', 'untracked')).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it('should re-throw GitNotRepoError for a non-git directory', async () => {
    const err = Object.assign(new Error('fatal: not a git repository'), {
      code: 128,
      stderr: 'fatal: not a git repository (or any of the parent directories): .git',
    });
    mockExecFileAsync.mockRejectedValue(err);

    await expect(getWorkingTreeDiff('/repo', 'src/a.ts', 'unstaged')).rejects.toBeInstanceOf(GitNotRepoError);
  });
});
