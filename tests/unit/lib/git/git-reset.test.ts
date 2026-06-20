/**
 * Tests for git-reset.ts (gitReset / gitRevert + reset default-branch guard).
 * Issue #782 / #783 (originally in git-utils.test.ts).
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

import { gitReset, gitRevert } from '@/lib/git/git-reset';
import { GitResetDefaultBranchError, GitIndexLockedError, GitTimeoutError } from '@/lib/git/git-errors';

/**
 * Dispatch git mock by the joined argv. Each key is matched as a substring of
 * `args.join(' ')`. Unmatched commands resolve to empty stdout.
 */
function mockGitByArgs(map: Record<string, string | (() => Promise<{ stdout: string }>)>) {
  mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
    const joined = args.join(' ');
    for (const [key, value] of Object.entries(map)) {
      if (joined.includes(key)) {
        if (typeof value === 'function') return value();
        return { stdout: value };
      }
    }
    return { stdout: '' };
  });
}

// ============================================================================
// Issue #782: reset / revert write operations
// ============================================================================

describe('gitReset (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git reset --soft <target> -- for a soft reset', async () => {
    mockGitByArgs({ 'reset': '' });
    await gitReset('/repo', { target: 'abc1234', mode: 'soft' });
    const resetCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset');
    expect(resetCall?.[1]).toEqual(['reset', '--soft', 'abc1234', '--']);
  });

  it('runs git reset --mixed HEAD -- for a mixed reset', async () => {
    mockGitByArgs({ 'reset': '' });
    await gitReset('/repo', { target: 'HEAD', mode: 'mixed' });
    const resetCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset');
    expect(resetCall?.[1]).toEqual(['reset', '--mixed', 'HEAD', '--']);
  });

  it('runs git reset --hard for a hard reset on a non-default branch', async () => {
    mockGitByArgs({
      'symbolic-ref': 'origin/main',
      'abbrev-ref': 'feature/x',
      'reset': '',
    });
    await gitReset('/repo', { target: 'HEAD', mode: 'hard' });
    const resetCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset');
    expect(resetCall?.[1]).toEqual(['reset', '--hard', 'HEAD', '--']);
  });

  it('rejects a hard reset on the default branch (origin/HEAD -> current)', async () => {
    mockGitByArgs({
      'symbolic-ref': 'origin/main',
      'abbrev-ref': 'main',
    });
    await expect(
      gitReset('/repo', { target: 'HEAD', mode: 'hard' })
    ).rejects.toBeInstanceOf(GitResetDefaultBranchError);
    // The reset must not run.
    expect(mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset')).toBeUndefined();
  });

  it('rejects a hard reset on main when origin/HEAD is unresolved (main/master fallback)', async () => {
    mockGitByArgs({
      'symbolic-ref': '',
      'abbrev-ref': 'main',
    });
    // symbolic-ref returns null (unresolved); fallback protects main/master.
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (joined.includes('abbrev-ref')) return { stdout: 'main\n' };
      return { stdout: '' };
    });
    await expect(
      gitReset('/repo', { target: 'HEAD', mode: 'hard' })
    ).rejects.toBeInstanceOf(GitResetDefaultBranchError);
  });

  it('does NOT block a soft/mixed reset on the default branch', async () => {
    mockGitByArgs({
      'symbolic-ref': 'origin/main',
      'abbrev-ref': 'main',
      'reset': '',
    });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'soft' })).resolves.toBeUndefined();
  });

  it('throws GitIndexLockedError when .git/index.lock exists', async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'soft' })).rejects.toBeInstanceOf(
      GitIndexLockedError
    );
  });
});

describe('gitRevert (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git revert <hash> -- for a normal revert', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    const result = await gitRevert('/repo', { commitHash: 'abc1234' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['revert', 'abc1234', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
    expect(result).toEqual({ conflict: false });
  });

  it('adds --no-commit when noCommit is true', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitRevert('/repo', { commitHash: 'abc1234', noCommit: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['revert', '--no-commit', 'abc1234', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('recovers conflict via err.stdout (200 conflict)', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in src/a.ts\n',
    });
    mockExecFileAsync.mockRejectedValue(err);
    const result = await gitRevert('/repo', { commitHash: 'abc1234' });
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['src/a.ts']);
  });

  it('re-throws GitTimeoutError on a killed process', async () => {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    await expect(gitRevert('/repo', { commitHash: 'abc1234' })).rejects.toBeInstanceOf(
      GitTimeoutError
    );
  });

  it('throws GitIndexLockedError when .git/index.lock exists', async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(gitRevert('/repo', { commitHash: 'abc1234' })).rejects.toBeInstanceOf(
      GitIndexLockedError
    );
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Issue #783: isDefaultBranchForReset byte-invariant boundary cases (DR1-002)
// Exercised through gitReset (the only caller). (a)-(d) lock the reset guard.
// ============================================================================

describe('isDefaultBranchForReset boundary (Issue #783, DR1-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  // (a) symbolic-ref returns origin/main, current=main -> protected TRUE.
  it('(a) protects when origin/HEAD resolves to origin/<current> (main)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'abbrev-ref': 'main' });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).rejects.toBeInstanceOf(
      GitResetDefaultBranchError
    );
    expect(mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset')).toBeUndefined();
  });

  // (b) THE CORE REGRESSION: symbolic-ref returns a NON-origin/ value, current=main
  //     -> protected FALSE (must NOT fall to the main/master fallback).
  it('(b) does NOT protect on a non-origin/ symbolic-ref value with current=main', async () => {
    mockGitByArgs({ 'symbolic-ref': 'upstream/main', 'abbrev-ref': 'main', 'reset': '' });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).resolves.toBeUndefined();
    expect(mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'reset')?.[1]).toEqual([
      'reset',
      '--hard',
      'HEAD',
      '--',
    ]);
  });

  it('(b2) does NOT protect on a bare-name symbolic-ref value with current=main', async () => {
    mockGitByArgs({ 'symbolic-ref': 'main', 'abbrev-ref': 'main', 'reset': '' });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).resolves.toBeUndefined();
  });

  // (c) symbolic-ref null (unresolved), current=main/master -> protected TRUE (S3-010).
  it('(c) protects main when origin/HEAD is unresolved (strong fallback)', async () => {
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (joined.includes('abbrev-ref')) return { stdout: 'main\n' };
      return { stdout: '' };
    });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).rejects.toBeInstanceOf(
      GitResetDefaultBranchError
    );
  });

  it('(c2) protects master when origin/HEAD is unresolved (strong fallback)', async () => {
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (joined.includes('abbrev-ref')) return { stdout: 'master\n' };
      return { stdout: '' };
    });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).rejects.toBeInstanceOf(
      GitResetDefaultBranchError
    );
  });

  // (d) symbolic-ref null (unresolved), current=feature -> protected FALSE.
  it('(d) does NOT protect a feature branch when origin/HEAD is unresolved', async () => {
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      if (joined.includes('abbrev-ref')) return { stdout: 'feature/x\n' };
      return { stdout: '' };
    });
    await expect(gitReset('/repo', { target: 'HEAD', mode: 'hard' })).resolves.toBeUndefined();
  });
});
