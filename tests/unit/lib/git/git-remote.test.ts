/**
 * Tests for git-remote.ts (gitFetch / gitPull / gitPush network operations).
 * Issue #783 Part 2 (originally in git-utils.test.ts).
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

import { gitFetch, gitPull, gitPush, gitRemoteAdd } from '@/lib/git/git-remote';
import {
  GitTimeoutError,
  GitNotRepoError,
  GitNetworkError,
  GitAuthFailedError,
  GitNonFastForwardError,
  GitProtectedBranchError,
  GitForceWithLeaseStaleError,
  GitIndexLockedError,
} from '@/lib/git/git-errors';
import {
  GIT_FETCH_TIMEOUT_MS,
  GIT_PULL_TIMEOUT_MS,
  GIT_PUSH_TIMEOUT_MS,
} from '@/config/git-status-config';

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
// Issue #783 (Part 2): gitFetch / gitPull / gitPush network operations.
// execGitNetworkAware is exercised through gitFetch / gitPush (it is not
// exported). gitPull goes through execGitConflictAware (timeout param).
// ============================================================================

describe('gitRemoteAdd (Issue #1480)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git remote add <name> <url>', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitRemoteAdd('/repo', 'upstream', 'https://github.com/orig/repo.git');
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['remote', 'add', 'upstream', 'https://github.com/orig/repo.git'],
      expect.objectContaining({ cwd: '/repo' })
    );
    // Local operation -> not serialized, so index.lock is never consulted.
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('propagates an error when the remote already exists', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'error: remote upstream already exists.' })
    );
    await expect(
      gitRemoteAdd('/repo', 'upstream', 'https://github.com/orig/repo.git')
    ).rejects.toThrow();
  });
});

describe('gitFetch (Issue #783, Part 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git fetch <remote> -- (no prune) and is NOT serialized', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitFetch('/repo', { remote: 'origin' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['fetch', 'origin', '--'],
      expect.objectContaining({ cwd: '/repo', timeout: GIT_FETCH_TIMEOUT_MS })
    );
    // NOT serialized -> no index.lock check (existsSync never consulted).
    expect(mockExistsSync).not.toHaveBeenCalled();
  });

  it('adds --prune when prune is true', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitFetch('/repo', { remote: 'upstream', prune: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['fetch', '--prune', 'upstream', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('throws GitTimeoutError on a killed process', async () => {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    await expect(gitFetch('/repo', { remote: 'origin' })).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it('throws GitNotRepoError when the directory is not a git repository', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'fatal: not a git repository' })
    );
    await expect(gitFetch('/repo', { remote: 'origin' })).rejects.toBeInstanceOf(GitNotRepoError);
  });

  it('classifies "Could not resolve host" stderr as GitNetworkError', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'fatal: ...: Could not resolve host: github.com' })
    );
    await expect(gitFetch('/repo', { remote: 'origin' })).rejects.toBeInstanceOf(GitNetworkError);
  });

  it('classifies "Authentication failed" stderr as GitAuthFailedError', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'fatal: Authentication failed for https://x' })
    );
    await expect(gitFetch('/repo', { remote: 'origin' })).rejects.toBeInstanceOf(GitAuthFailedError);
  });

  it('does NOT log raw stderr/message containing a credential URL', async () => {
    const leak = "fatal: unable to access 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error(leak), { stderr: leak }));
    await expect(gitFetch('/repo', { remote: 'origin' })).rejects.toBeInstanceOf(GitNetworkError);
    const allLogArgs = JSON.stringify([
      ...mockLogger.error.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.info.mock.calls,
      ...mockLogger.debug.mock.calls,
    ]);
    expect(allLogArgs).not.toContain('glpat-SECRET');
    expect(allLogArgs).not.toContain('ci-bot');
  });
});

describe('gitPull (Issue #783, Part 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git pull <remote> <branch> -- with GIT_PULL_TIMEOUT_MS (serialized)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    const result = await gitPull('/repo', { remote: 'origin', branch: 'main' });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['pull', 'origin', 'main', '--'],
      expect.objectContaining({ cwd: '/repo', timeout: GIT_PULL_TIMEOUT_MS })
    );
    expect(result).toEqual({ conflict: false });
    // Serialized -> index.lock check consulted.
    expect(mockExistsSync).toHaveBeenCalled();
  });

  it('adds --rebase when rebase is true', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitPull('/repo', { remote: 'origin', branch: 'main', rebase: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['pull', '--rebase', 'origin', 'main', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('adds --ff-only when ffOnly is true', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitPull('/repo', { remote: 'origin', branch: 'main', ffOnly: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['pull', '--ff-only', 'origin', 'main', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('recovers a merge conflict via err.stdout (200 conflict)', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in src/a.ts\n',
    });
    mockExecFileAsync.mockRejectedValue(err);
    const result = await gitPull('/repo', { remote: 'origin', branch: 'main' });
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['src/a.ts']);
  });

  it('classifies a non-fast-forward failure (no longer a raw generic error)', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'error: failed to push (non-fast-forward)' })
    );
    await expect(gitPull('/repo', { remote: 'origin', branch: 'main' })).rejects.toBeInstanceOf(
      GitNonFastForwardError
    );
  });

  it('classifies an auth failure', async () => {
    mockExecFileAsync.mockRejectedValue(
      Object.assign(new Error('x'), { stderr: 'fatal: Authentication failed for https://x' })
    );
    await expect(gitPull('/repo', { remote: 'origin', branch: 'main' })).rejects.toBeInstanceOf(
      GitAuthFailedError
    );
  });

  it('re-throws GitTimeoutError on a killed process', async () => {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    await expect(gitPull('/repo', { remote: 'origin', branch: 'main' })).rejects.toBeInstanceOf(
      GitTimeoutError
    );
  });

  it('DR4-002: does NOT log a raw credential-bearing URL on the network-generic path', async () => {
    const leak = "fatal: unable to access 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error(leak), { stderr: leak }));
    await expect(gitPull('/repo', { remote: 'origin', branch: 'main' })).rejects.toBeInstanceOf(
      GitNetworkError
    );
    const allLogArgs = JSON.stringify([
      ...mockLogger.error.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.info.mock.calls,
      ...mockLogger.debug.mock.calls,
    ]);
    expect(allLogArgs).not.toContain('glpat-SECRET');
    expect(allLogArgs).not.toContain('ci-bot');
  });
});

describe('gitPush (Issue #783, Part 2)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('pushes with an explicit refspec <branch>:refs/heads/<branch> (GIT_PUSH_TIMEOUT_MS, serialized)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature' });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toEqual(['push', 'origin', 'feature:refs/heads/feature', '--']);
    expect(pushCall?.[2]).toEqual(expect.objectContaining({ timeout: GIT_PUSH_TIMEOUT_MS }));
    expect(mockExistsSync).toHaveBeenCalled(); // serialized
  });

  it('DR4-004: builds feature:refs/heads/feature (NOT main) even when the upstream is main', async () => {
    // push.default=upstream scenario: a naive impl might force-update origin/main.
    // The explicit refspec must target refs/heads/feature deterministically.
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', force: true });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toContain('feature:refs/heads/feature');
    expect(pushCall?.[1]).not.toContain('feature:refs/heads/main');
    expect(pushCall?.[1].join(' ')).not.toContain(':refs/heads/main');
  });

  it('adds -u when setUpstream is true', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', setUpstream: true });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toEqual(['push', '-u', 'origin', 'feature:refs/heads/feature', '--']);
  });

  it('adds --force-with-lease when forceWithLease is true', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', forceWithLease: true });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toEqual([
      'push',
      '--force-with-lease',
      'origin',
      'feature:refs/heads/feature',
      '--',
    ]);
  });

  it('adds --force when force is true (non-default branch)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', force: true });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toContain('--force');
    expect(pushCall?.[1]).not.toContain('--force-with-lease');
  });

  it('prefers --force-with-lease over --force when both are set', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', force: true, forceWithLease: true });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toContain('--force-with-lease');
    expect(pushCall?.[1]).not.toContain('--force');
  });

  it('does NOT add any force flag for a plain push', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature' });
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).not.toContain('--force');
    expect(pushCall?.[1]).not.toContain('--force-with-lease');
  });

  it('throws GitProtectedBranchError on a force push to the default branch', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main' });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'main', force: true })
    ).rejects.toBeInstanceOf(GitProtectedBranchError);
    // The push must not run.
    expect(mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push')).toBeUndefined();
  });

  it('throws GitProtectedBranchError on a force-with-lease push to the default branch', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main' });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'main', forceWithLease: true })
    ).rejects.toBeInstanceOf(GitProtectedBranchError);
  });

  it('allows a NON-force push to the default branch (protection only applies to force)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await expect(gitPush('/repo', { remote: 'origin', branch: 'main' })).resolves.toBeUndefined();
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toEqual(['push', 'origin', 'main:refs/heads/main', '--']);
  });

  it('allows a force push when the default branch is UNRESOLVED (non-symmetric vs reset)', async () => {
    // resolveDefaultBranchName collapses UNRESOLVED -> null -> NOT protected.
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      return { stdout: '' };
    });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'main', force: true })
    ).resolves.toBeUndefined();
    const pushCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'push');
    expect(pushCall?.[1]).toContain('--force');
  });

  it('emits a structured force-push danger log WITHOUT credentials', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main', 'push': '' });
    await gitPush('/repo', { remote: 'origin', branch: 'feature', forceWithLease: true });
    const warnCall = mockLogger.warn.mock.calls.find((c) => c[0] === 'git:danger:force-push');
    expect(warnCall).toBeDefined();
    const payload = JSON.stringify(warnCall?.[1]);
    expect(payload).not.toContain('glpat');
    // The danger log carries only worktreePath / branch / timestamp (no remote URL/creds).
    expect(warnCall?.[1]).toEqual(
      expect.objectContaining({ operation: 'push', worktreePath: '/repo', branch: 'feature' })
    );
  });

  it('classifies a non-fast-forward push rejection', async () => {
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main' };
      if (args[0] === 'push') {
        throw Object.assign(new Error('x'), { stderr: '! [rejected] (fetch first)' });
      }
      return { stdout: '' };
    });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'feature' })
    ).rejects.toBeInstanceOf(GitNonFastForwardError);
  });

  it('classifies a stale-info force-with-lease rejection', async () => {
    mockExecFileAsync.mockImplementation(async (_f: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main' };
      if (args[0] === 'push') {
        throw Object.assign(new Error('x'), { stderr: '! [rejected] (stale info)' });
      }
      return { stdout: '' };
    });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'feature', forceWithLease: true })
    ).rejects.toBeInstanceOf(GitForceWithLeaseStaleError);
  });

  it('throws GitIndexLockedError when .git/index.lock exists (serialized)', async () => {
    mockExistsSync.mockReturnValue(true);
    // symbolic-ref resolves so protection check passes; the serialized push then
    // hits the index.lock guard.
    mockGitByArgs({ 'symbolic-ref': 'origin/develop' });
    await expect(
      gitPush('/repo', { remote: 'origin', branch: 'feature' })
    ).rejects.toBeInstanceOf(GitIndexLockedError);
  });
});
