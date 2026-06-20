/**
 * Tests for git-commit.ts (stageFiles / unstageFiles / gitCommit).
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

import { stageFiles, unstageFiles, gitCommit } from '@/lib/git/git-commit';
import { GitIndexLockedError, GitNothingToCommitError } from '@/lib/git/git-errors';

// ============================================================================
// Issue #780: stageFiles / unstageFiles / gitCommit
// ============================================================================

describe('git write operations (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no index.lock present
    mockExistsSync.mockReturnValue(false);
  });

  it('stageFiles should call git add -- with the file list', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await stageFiles('/repo', ['a.ts', 'b.ts']);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['add', '--', 'a.ts', 'b.ts'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('unstageFiles should call git restore --staged --', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await unstageFiles('/repo', ['a.ts']);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['restore', '--staged', '--', 'a.ts'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('gitCommit should call git commit -m <message> -- (no amend)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await gitCommit('/repo', 'feat: thing', false);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'feat: thing', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('gitCommit should add --amend when amend is true', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });

    await gitCommit('/repo', 'reword', true);

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['commit', '-m', 'reword', '--amend', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('gitCommit should normalize "nothing to commit" into GitNothingToCommitError', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('nothing to commit, working tree clean'));

    await expect(gitCommit('/repo', 'noop', false)).rejects.toBeInstanceOf(GitNothingToCommitError);
  });

  it('should throw GitIndexLockedError when .git/index.lock exists (stage)', async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(stageFiles('/repo', ['a.ts'])).rejects.toBeInstanceOf(GitIndexLockedError);
    // git add must not run when the index is locked
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('should throw GitIndexLockedError when .git/index.lock exists (commit)', async () => {
    mockExistsSync.mockReturnValue(true);

    await expect(gitCommit('/repo', 'x', false)).rejects.toBeInstanceOf(GitIndexLockedError);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

});
