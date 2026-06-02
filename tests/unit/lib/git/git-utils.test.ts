/**
 * Tests for git-utils.ts commit log functions
 * Issue #627: Commit log in report
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they are available in vi.mock() factories
const { mockExistsSync, mockExecFileAsync, mockLogger } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
  // Single shared logger instance (git-utils calls createLogger once at module
  // load). Exposing it lets DR4-002 tests assert no credential reaches the log.
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));

// Mock logger
vi.mock('@/lib/logger', () => {
  mockLogger.withContext.mockReturnValue(mockLogger);
  return {
    createLogger: vi.fn(() => mockLogger),
  };
});

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

import {
  getCommitsByDateRange,
  collectRepositoryCommitLogs,
  extractIssueNumbers,
  parsePorcelainStatus,
  getStagedStatus,
  stageFiles,
  unstageFiles,
  gitCommit,
  getWorkingTreeDiff,
  getGitStatus,
  listBranches,
  parseWorktreePorcelain,
  parseForEachRefTracking,
  checkoutBranch,
  createBranch,
  deleteBranch,
  handleGitApiError,
  GitIndexLockedError,
  GitNothingToCommitError,
  GitTimeoutError,
  GitNotRepoError,
  GitBranchNotFoundError,
  GitBranchNotMergedError,
  GitBranchCheckedOutElsewhereError,
  GitDirtyError,
  GitCurrentBranchError,
  GitDefaultBranchError,
  // Issue #782: stash + reset/revert
  parseStashList,
  getStashList,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
  gitReset,
  gitRevert,
  GitNothingToStashError,
  GitResetDefaultBranchError,
  // Issue #783: network operation foundation
  getDefaultBranch,
  resolveDefaultBranchName,
  DEFAULT_BRANCH_UNRESOLVED,
  GitAuthFailedError,
  GitNonFastForwardError,
  GitNoUpstreamError,
  GitProtectedBranchError,
  GitForceWithLeaseStaleError,
  GitNetworkError,
  // Issue #783 (Part 2): network operations + stderr classification
  classifyNetworkStderr,
  gitFetch,
  gitPull,
  gitPush,
} from '@/lib/git/git-utils';
import { GIT_FETCH_TIMEOUT_MS, GIT_PULL_TIMEOUT_MS, GIT_PUSH_TIMEOUT_MS } from '@/config/git-status-config';

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

describe('extractIssueNumbers (Issue #630)', () => {
  it('should extract simple #NNN patterns', () => {
    expect(extractIssueNumbers(['fix bug #123'])).toEqual([123]);
  });

  it('should extract Closes #NNN patterns', () => {
    expect(extractIssueNumbers(['Closes #456'])).toEqual([456]);
  });

  it('should extract Fixes #NNN patterns', () => {
    expect(extractIssueNumbers(['Fixes #789'])).toEqual([789]);
  });

  it('should extract Resolves #NNN patterns', () => {
    expect(extractIssueNumbers(['Resolves #100'])).toEqual([100]);
  });

  it('should extract multiple issue numbers from one message', () => {
    const result = extractIssueNumbers(['fix #1 and #2']);
    expect(result).toContain(1);
    expect(result).toContain(2);
  });

  it('should return unique issue numbers across multiple messages', () => {
    const result = extractIssueNumbers(['fix #123', 'also #123 and #456']);
    expect(result).toEqual(expect.arrayContaining([123, 456]));
    expect(result).toHaveLength(2);
  });

  it('should return empty array for no matches', () => {
    expect(extractIssueNumbers(['no issue here'])).toEqual([]);
  });

  it('should handle empty array', () => {
    expect(extractIssueNumbers([])).toEqual([]);
  });

  it('should be case-insensitive for keywords', () => {
    expect(extractIssueNumbers(['closes #10'])).toEqual([10]);
    expect(extractIssueNumbers(['FIXES #20'])).toEqual([20]);
  });

  it('should handle mixed patterns in multiple messages', () => {
    const msgs = ['feat: add feature #630', 'Closes #627', 'Fixes #626'];
    const result = extractIssueNumbers(msgs);
    expect(result).toContain(630);
    expect(result).toContain(627);
    expect(result).toContain(626);
  });
});

// ============================================================================
// Issue #780: parsePorcelainStatus
// ============================================================================

describe('parsePorcelainStatus (Issue #780)', () => {
  it('should return empty buckets for empty input', () => {
    expect(parsePorcelainStatus('')).toEqual({ staged: [], unstaged: [], untracked: [] });
  });

  it('should classify ?? as untracked', () => {
    const result = parsePorcelainStatus('?? new-file.ts\n');
    expect(result.untracked).toEqual([{ path: 'new-file.ts', status: 'untracked' }]);
    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([]);
  });

  it('should classify " M" (worktree modified) as unstaged modified', () => {
    const result = parsePorcelainStatus(' M src/foo.ts\n');
    expect(result.staged).toEqual([]);
    expect(result.unstaged).toEqual([{ path: 'src/foo.ts', status: 'modified' }]);
  });

  it('should classify "M " (index modified) as staged modified', () => {
    const result = parsePorcelainStatus('M  src/foo.ts\n');
    expect(result.staged).toEqual([{ path: 'src/foo.ts', status: 'modified' }]);
    expect(result.unstaged).toEqual([]);
  });

  it('should classify "MM" as both staged and unstaged modified', () => {
    const result = parsePorcelainStatus('MM src/foo.ts\n');
    expect(result.staged).toEqual([{ path: 'src/foo.ts', status: 'modified' }]);
    expect(result.unstaged).toEqual([{ path: 'src/foo.ts', status: 'modified' }]);
  });

  it('should classify "A " (added to index) as staged added', () => {
    const result = parsePorcelainStatus('A  new.ts\n');
    expect(result.staged).toEqual([{ path: 'new.ts', status: 'added' }]);
  });

  it('should classify " D" (worktree deleted) as unstaged deleted', () => {
    const result = parsePorcelainStatus(' D gone.ts\n');
    expect(result.unstaged).toEqual([{ path: 'gone.ts', status: 'deleted' }]);
  });

  it('should classify "D " (index deleted) as staged deleted', () => {
    const result = parsePorcelainStatus('D  gone.ts\n');
    expect(result.staged).toEqual([{ path: 'gone.ts', status: 'deleted' }]);
  });

  it('should use the new path for renames (R old -> new)', () => {
    const result = parsePorcelainStatus('R  old.ts -> new.ts\n');
    expect(result.staged).toEqual([{ path: 'new.ts', status: 'renamed' }]);
  });

  it('should classify "UU" as unmerged in the unstaged bucket', () => {
    const result = parsePorcelainStatus('UU conflict.ts\n');
    expect(result.unstaged).toEqual([{ path: 'conflict.ts', status: 'unmerged' }]);
    expect(result.staged).toEqual([]);
  });

  it('should classify "AA" as unmerged', () => {
    const result = parsePorcelainStatus('AA both-added.ts\n');
    expect(result.unstaged).toEqual([{ path: 'both-added.ts', status: 'unmerged' }]);
  });

  it('should classify "DD" as unmerged', () => {
    const result = parsePorcelainStatus('DD both-deleted.ts\n');
    expect(result.unstaged).toEqual([{ path: 'both-deleted.ts', status: 'unmerged' }]);
  });

  it('should classify "AU" (added by us) as unmerged', () => {
    const result = parsePorcelainStatus('AU theirs.ts\n');
    expect(result.unstaged).toEqual([{ path: 'theirs.ts', status: 'unmerged' }]);
  });

  it('should handle a mixed multi-line status', () => {
    const output = [
      'M  staged-mod.ts',
      ' M worktree-mod.ts',
      'A  added.ts',
      '?? untracked.ts',
      'UU conflict.ts',
      'R  old.ts -> renamed.ts',
    ].join('\n') + '\n';

    const result = parsePorcelainStatus(output);

    expect(result.staged).toEqual([
      { path: 'staged-mod.ts', status: 'modified' },
      { path: 'added.ts', status: 'added' },
      { path: 'renamed.ts', status: 'renamed' },
    ]);
    expect(result.unstaged).toEqual([
      { path: 'worktree-mod.ts', status: 'modified' },
      { path: 'conflict.ts', status: 'unmerged' },
    ]);
    expect(result.untracked).toEqual([{ path: 'untracked.ts', status: 'untracked' }]);
  });

  it('should skip blank / malformed lines', () => {
    const result = parsePorcelainStatus('\n  \nxy\n M ok.ts\n');
    expect(result.unstaged).toEqual([{ path: 'ok.ts', status: 'modified' }]);
  });
});

// ============================================================================
// Issue #780: getStagedStatus / stageFiles / unstageFiles / gitCommit
// ============================================================================

describe('getStagedStatus (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run git status --porcelain and parse the output', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: 'M  a.ts\n?? b.ts\n' });

    const result = await getStagedStatus('/repo');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['status', '--porcelain'],
      expect.objectContaining({ cwd: '/repo' })
    );
    expect(result.staged).toEqual([{ path: 'a.ts', status: 'modified' }]);
    expect(result.untracked).toEqual([{ path: 'b.ts', status: 'untracked' }]);
  });
});

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

describe('git write operations - serialization (Issue #780)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('should serialize concurrent writes for the same worktree', async () => {
    const order: string[] = [];
    let resolveFirst: (() => void) | undefined;
    mockExecFileAsync
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            order.push('first-start');
            resolveFirst = () => {
              order.push('first-end');
              resolve({ stdout: '' });
            };
          })
      )
      .mockImplementationOnce(async () => {
        order.push('second-start');
        return { stdout: '' };
      });

    const p1 = stageFiles('/repo', ['a.ts']);
    const p2 = stageFiles('/repo', ['b.ts']);

    // The second op must not start until the first resolves. Flush a few
    // microtask ticks so the serialization chain has a chance to start op #1.
    for (let i = 0; i < 5; i++) {
      await Promise.resolve();
    }
    expect(order).toEqual(['first-start']);

    resolveFirst?.();
    await Promise.all([p1, p2]);

    expect(order).toEqual(['first-start', 'first-end', 'second-start']);
  });
});

// ============================================================================
// Issue #781: listBranches (read path, best-effort, non-throw)
// ============================================================================

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
// Issue #781: branch-list parsing helpers (exported pure functions). Tested
// directly so their contract is locked independently of listBranches wiring.
// ============================================================================

describe('parseWorktreePorcelain (Issue #781)', () => {
  it('returns an empty map for empty input', () => {
    expect(parseWorktreePorcelain('').size).toBe(0);
  });

  it('maps short branch names to their worktree path (refs/heads/ stripped)', () => {
    const out =
      'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
      'worktree /other/path\nHEAD def\nbranch refs/heads/feature/other\n\n';
    const map = parseWorktreePorcelain(out);
    expect(map.get('main')).toBe('/repo');
    expect(map.get('feature/other')).toBe('/other/path');
  });

  it('contributes no mapping for a detached-HEAD record', () => {
    const out = 'worktree /repo\nHEAD abc\ndetached\n\n';
    const map = parseWorktreePorcelain(out);
    expect(map.size).toBe(0);
  });

  it('tolerates a trailing record without a blank-line terminator', () => {
    const out = 'worktree /repo\nHEAD abc\nbranch refs/heads/main';
    const map = parseWorktreePorcelain(out);
    expect(map.get('main')).toBe('/repo');
  });
});

describe('parseForEachRefTracking (Issue #781)', () => {
  it('returns an empty map for empty input', () => {
    expect(parseForEachRefTracking('').size).toBe(0);
  });

  it('parses ahead+behind counts', () => {
    const map = parseForEachRefTracking('feature/x\torigin/feature/x\t[ahead 2, behind 1]');
    expect(map.get('feature/x')).toEqual({
      upstream: 'origin/feature/x',
      aheadBehind: { ahead: 2, behind: 1 },
    });
  });

  it('defaults the missing side to 0 for ahead-only / behind-only', () => {
    const aheadOnly = parseForEachRefTracking('a\torigin/a\t[ahead 3]');
    expect(aheadOnly.get('a')?.aheadBehind).toEqual({ ahead: 3, behind: 0 });
    const behindOnly = parseForEachRefTracking('b\torigin/b\t[behind 4]');
    expect(behindOnly.get('b')?.aheadBehind).toEqual({ ahead: 0, behind: 4 });
  });

  it('reports in-sync (0/0) when an upstream is set but no track is reported', () => {
    const map = parseForEachRefTracking('main\torigin/main\t');
    expect(map.get('main')).toEqual({
      upstream: 'origin/main',
      aheadBehind: { ahead: 0, behind: 0 },
    });
  });

  it('yields aheadBehind null for a [gone] upstream', () => {
    const map = parseForEachRefTracking('stale\torigin/stale\t[gone]');
    expect(map.get('stale')).toEqual({ upstream: 'origin/stale', aheadBehind: null });
  });

  it('yields upstream null and aheadBehind null when there is no upstream', () => {
    const map = parseForEachRefTracking('local-only\t\t');
    expect(map.get('local-only')).toEqual({ upstream: null, aheadBehind: null });
  });
});

describe('listBranches (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('parses local branches and marks the current branch', async () => {
    mockGitByArgs({
      // `git branch`
      'branch --list': '* feature/781-worktree\n  main\n  develop\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': 'feature/781-worktree\t\t\nmain\torigin/main\t\ndevelop\t\t\n',
    });

    const branches = await listBranches('/repo', 'local');
    const names = branches.map((b) => b.name);
    expect(names).toContain('feature/781-worktree');
    expect(names).toContain('main');
    const current = branches.find((b) => b.name === 'feature/781-worktree');
    expect(current?.isCurrent).toBe(true);
    const mainBranch = branches.find((b) => b.name === 'main');
    expect(mainBranch?.isCurrent).toBe(false);
    expect(mainBranch?.isRemote).toBe(false);
  });

  it('marks the default branch from origin/HEAD', async () => {
    mockGitByArgs({
      'branch --list': '* main\n  feature/x\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': 'main\t\t\nfeature/x\t\t\n',
    });

    const branches = await listBranches('/repo', 'local');
    const mainBranch = branches.find((b) => b.name === 'main');
    expect(mainBranch?.isDefault).toBe(true);
    const feature = branches.find((b) => b.name === 'feature/x');
    expect(feature?.isDefault).toBe(false);
  });

  it('degrades isDefault to false when symbolic-ref fails (non-throw)', async () => {
    mockGitByArgs({
      'branch --list': '* main\n',
      'symbolic-ref': async () => {
        throw new Error('no origin/HEAD');
      },
      'worktree list': '',
      'for-each-ref': 'main\t\t\n',
    });

    const branches = await listBranches('/repo', 'local');
    expect(branches.every((b) => b.isDefault === false)).toBe(true);
    expect(branches[0].name).toBe('main');
  });

  it('includes remote branches with include=remote', async () => {
    mockGitByArgs({
      'branch -r': '  origin/main\n  origin/feature/y\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': '',
    });

    const branches = await listBranches('/repo', 'remote');
    expect(branches.map((b) => b.name)).toEqual(
      expect.arrayContaining(['origin/main', 'origin/feature/y'])
    );
    expect(branches.every((b) => b.isRemote === true)).toBe(true);
  });

  it('ignores the remote HEAD pointer line (origin/HEAD -> origin/main)', async () => {
    mockGitByArgs({
      'branch -r': '  origin/HEAD -> origin/main\n  origin/main\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': '',
    });

    const branches = await listBranches('/repo', 'remote');
    expect(branches.map((b) => b.name)).not.toContain('origin/HEAD');
    expect(branches.map((b) => b.name)).toContain('origin/main');
  });

  it('include=all returns both local and remote', async () => {
    mockGitByArgs({
      'branch --list': '* main\n',
      'branch -r': '  origin/main\n  origin/dev\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': 'main\torigin/main\t\n',
    });

    const branches = await listBranches('/repo', 'all');
    const names = branches.map((b) => b.name);
    expect(names).toContain('main');
    expect(names).toContain('origin/dev');
  });

  it('maps checkedOutWorktreePath from git worktree list --porcelain', async () => {
    mockGitByArgs({
      'branch --list': '* main\n  feature/other\n',
      'symbolic-ref': 'origin/main',
      'worktree list':
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /other/path\nHEAD def\nbranch refs/heads/feature/other\n\n',
      'for-each-ref': 'main\t\t\nfeature/other\t\t\n',
    });

    const branches = await listBranches('/repo', 'local');
    const other = branches.find((b) => b.name === 'feature/other');
    expect(other?.checkedOutWorktreePath).toBe('/other/path');
    const main = branches.find((b) => b.name === 'main');
    // main is checked out in the current worktree path (/repo) — still recorded.
    expect(main?.checkedOutWorktreePath).toBe('/repo');
  });

  it('parses upstream and aheadBehind from for-each-ref track output', async () => {
    mockGitByArgs({
      'branch --list': '* feature/x\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': 'feature/x\torigin/feature/x\t[ahead 2, behind 1]\n',
    });

    const branches = await listBranches('/repo', 'local');
    const fx = branches.find((b) => b.name === 'feature/x');
    expect(fx?.upstream).toBe('origin/feature/x');
    expect(fx?.aheadBehind).toEqual({ ahead: 2, behind: 1 });
  });

  it('sets upstream null and aheadBehind null when there is no upstream', async () => {
    mockGitByArgs({
      'branch --list': '* feature/x\n',
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': 'feature/x\t\t\n',
    });

    const branches = await listBranches('/repo', 'local');
    const fx = branches.find((b) => b.name === 'feature/x');
    expect(fx?.upstream).toBeNull();
    expect(fx?.aheadBehind).toBeNull();
  });

  it('returns an empty array (non-throw) when git branch itself fails', async () => {
    mockGitByArgs({
      'branch --list': async () => {
        throw new Error('not a git repository');
      },
      'symbolic-ref': 'origin/main',
      'worktree list': '',
      'for-each-ref': '',
    });

    const branches = await listBranches('/repo', 'local');
    expect(branches).toEqual([]);
  });
});

// ============================================================================
// Issue #781: getGitStatus byte-invariant regression (#779/#780 invariant)
// ============================================================================

describe('getGitStatus byte-invariant (Issue #781 regression)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs EXACTLY the three #779 read commands (no branch/worktree-list reads)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/x\n' };
      if (joined.includes('--short HEAD')) return { stdout: 'abc1234\n' };
      if (joined.includes('status --porcelain')) return { stdout: '' };
      return { stdout: '' };
    });

    const status = await getGitStatus('/repo', 'main');

    // Exactly three commands, unchanged from #779.
    expect(calls).toEqual([
      ['rev-parse', '--abbrev-ref', 'HEAD'],
      ['rev-parse', '--short', 'HEAD'],
      ['status', '--porcelain'],
    ]);
    expect(status.currentBranch).toBe('feature/x');
    expect(status.commitHash).toBe('abc1234');
    expect(status.isDirty).toBe(false);
    expect(status.isBranchMismatch).toBe(true);
  });
});

// ============================================================================
// Issue #781: checkout / create / delete write functions + typed errors
// ============================================================================

describe('checkoutBranch (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('switches to an existing local branch (clean tree)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('worktree list')) return { stdout: '' };
      if (joined.includes('status --porcelain')) return { stdout: '' };
      return { stdout: '' };
    });

    await checkoutBranch('/repo', { branch: 'feature/x' });

    const switchCall = calls.find((a) => a[0] === 'switch');
    expect(switchCall).toEqual(['switch', 'feature/x', '--']);
  });

  it('rejects checkout when the branch is checked out in another worktree (409 checked_out_elsewhere)', async () => {
    mockGitByArgs({
      'worktree list':
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /other\nHEAD def\nbranch refs/heads/feature/x\n\n',
      'status --porcelain': '',
    });

    await expect(checkoutBranch('/repo', { branch: 'feature/x' })).rejects.toBeInstanceOf(
      GitBranchCheckedOutElsewhereError
    );
  });

  it('checked_out_elsewhere is not bypassable with force', async () => {
    mockGitByArgs({
      'worktree list':
        'worktree /repo\nHEAD abc\nbranch refs/heads/main\n\n' +
        'worktree /other\nHEAD def\nbranch refs/heads/feature/x\n\n',
      'status --porcelain': '',
    });

    await expect(
      checkoutBranch('/repo', { branch: 'feature/x', force: true })
    ).rejects.toBeInstanceOf(GitBranchCheckedOutElsewhereError);
  });

  it('rejects checkout when the tree is dirty and force is false (409 dirty)', async () => {
    mockGitByArgs({
      'worktree list': '',
      'status --porcelain': ' M src/a.ts\n',
    });

    await expect(checkoutBranch('/repo', { branch: 'feature/x' })).rejects.toBeInstanceOf(
      GitDirtyError
    );
  });

  it('allows a force checkout over a dirty tree (git checkout -f)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('worktree list')) return { stdout: '' };
      if (joined.includes('status --porcelain')) return { stdout: ' M a.ts\n' };
      return { stdout: '' };
    });

    await checkoutBranch('/repo', { branch: 'feature/x', force: true });
    const forceCall = calls.find((a) => a[0] === 'checkout' && a.includes('-f'));
    expect(forceCall).toEqual(['checkout', '-f', 'feature/x', '--']);
  });

  it('creates a new branch with createIfMissing (git switch -c)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('worktree list')) return { stdout: '' };
      if (joined.includes('status --porcelain')) return { stdout: '' };
      return { stdout: '' };
    });

    await checkoutBranch('/repo', { branch: 'feature/new', createIfMissing: true, from: 'main' });
    const createCall = calls.find((a) => a[0] === 'switch' && a.includes('-c'));
    expect(createCall).toEqual(['switch', '-c', 'feature/new', 'main', '--']);
  });

  it('checks out a remote branch as a local tracking branch (no detached HEAD, S3-008)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('worktree list')) return { stdout: '' };
      if (joined.includes('status --porcelain')) return { stdout: '' };
      return { stdout: '' };
    });

    await checkoutBranch('/repo', { branch: 'origin/feature/y' });
    const trackCall = calls.find((a) => a.includes('--track'));
    expect(trackCall).toEqual(['switch', '-c', 'feature/y', '--track', 'origin/feature/y', '--']);
  });

  it('normalizes a "did not match any" git error to GitBranchNotFoundError (404)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('worktree list')) return { stdout: '' };
      if (joined.includes('status --porcelain')) return { stdout: '' };
      const err = new Error("error: pathspec 'nope' did not match any file(s) known to git") as Error & { stderr?: string };
      err.stderr = "error: pathspec 'nope' did not match any file(s) known to git";
      throw err;
    });

    await expect(checkoutBranch('/repo', { branch: 'nope' })).rejects.toBeInstanceOf(
      GitBranchNotFoundError
    );
  });
});

describe('createBranch (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('creates a branch with git branch <name> -- (no checkout)', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });

    await createBranch('/repo', { name: 'feature/created' });
    const createCall = calls.find((a) => a[0] === 'branch');
    expect(createCall).toEqual(['branch', 'feature/created', '--']);
  });

  it('creates a branch from a base ref', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: '' };
    });

    await createBranch('/repo', { name: 'feature/created', from: 'main' });
    const createCall = calls.find((a) => a[0] === 'branch');
    expect(createCall).toEqual(['branch', 'feature/created', 'main', '--']);
  });
});

describe('deleteBranch (Issue #781)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('deletes a merged branch with git branch -d', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'main\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });

    await deleteBranch('/repo', { name: 'feature/done' });
    const delCall = calls.find((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D')));
    expect(delCall).toEqual(['branch', '-d', 'feature/done', '--']);
  });

  it('force-deletes with git branch -D when force is true', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'main\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });

    await deleteBranch('/repo', { name: 'feature/wip', force: true });
    const delCall = calls.find((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D')));
    expect(delCall).toEqual(['branch', '-D', 'feature/wip', '--']);
  });

  it('rejects deleting the current branch (409 current_branch)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/current\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });

    await expect(deleteBranch('/repo', { name: 'feature/current' })).rejects.toBeInstanceOf(
      GitCurrentBranchError
    );
  });

  it('rejects deleting the default branch (409 default_branch)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/x\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });

    await expect(deleteBranch('/repo', { name: 'main' })).rejects.toBeInstanceOf(
      GitDefaultBranchError
    );
  });

  it('normalizes "not fully merged" stderr to GitBranchNotMergedError (409)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'main\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (args[0] === 'branch' && (args.includes('-d') || args.includes('-D'))) {
        const err = new Error("error: The branch 'feature/x' is not fully merged.") as Error & { stderr?: string };
        err.stderr = "error: The branch 'feature/x' is not fully merged.";
        throw err;
      }
      return { stdout: '' };
    });

    await expect(deleteBranch('/repo', { name: 'feature/x' })).rejects.toBeInstanceOf(
      GitBranchNotMergedError
    );
  });

  it('normalizes "not found" stderr to GitBranchNotFoundError (404)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'main\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      if (args[0] === 'branch' && (args.includes('-d') || args.includes('-D'))) {
        const err = new Error("error: branch 'nope' not found.") as Error & { stderr?: string };
        err.stderr = "error: branch 'nope' not found.";
        throw err;
      }
      return { stdout: '' };
    });

    await expect(deleteBranch('/repo', { name: 'nope' })).rejects.toBeInstanceOf(
      GitBranchNotFoundError
    );
  });
});

// ============================================================================
// Issue #781: handleGitApiError reason mapping
// ============================================================================

describe('handleGitApiError branch reasons (Issue #781)', () => {
  async function statusAndReason(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { reason?: string; worktreePath?: string };
    return { status: res.status, reason: body.reason, worktreePath: body.worktreePath };
  }

  it('maps GitBranchNotFoundError to 404 branch_not_found', async () => {
    expect(await statusAndReason(new GitBranchNotFoundError('x'))).toMatchObject({
      status: 404,
      reason: 'branch_not_found',
    });
  });

  it('maps GitBranchNotMergedError to 409 not_merged', async () => {
    expect(await statusAndReason(new GitBranchNotMergedError('x'))).toMatchObject({
      status: 409,
      reason: 'not_merged',
    });
  });

  it('maps GitCurrentBranchError to 409 current_branch', async () => {
    expect(await statusAndReason(new GitCurrentBranchError('x'))).toMatchObject({
      status: 409,
      reason: 'current_branch',
    });
  });

  it('maps GitDefaultBranchError to 409 default_branch', async () => {
    expect(await statusAndReason(new GitDefaultBranchError('x'))).toMatchObject({
      status: 409,
      reason: 'default_branch',
    });
  });

  it('maps GitDirtyError to 409 dirty', async () => {
    expect(await statusAndReason(new GitDirtyError('x'))).toMatchObject({
      status: 409,
      reason: 'dirty',
    });
  });

  it('maps GitBranchCheckedOutElsewhereError to 409 checked_out_elsewhere with worktreePath', async () => {
    const result = await statusAndReason(new GitBranchCheckedOutElsewhereError('x', '/other/wt'));
    expect(result.status).toBe(409);
    expect(result.reason).toBe('checked_out_elsewhere');
    expect(result.worktreePath).toBe('/other/wt');
  });
});

// ============================================================================
// Issue #782: stash list parsing (pure function)
// ============================================================================

describe('parseStashList (Issue #782)', () => {
  it('returns an empty array for empty input', () => {
    expect(parseStashList('')).toEqual([]);
    expect(parseStashList('   \n  ')).toEqual([]);
  });

  it('parses a WIP-on stash row (index / message / branch / date / sha)', () => {
    const out = 'stash@{0}\tWIP on main: 1a2b3c4 fix thing\t2026-01-02T03:04:05+09:00\tdeadbeef0123456789abcdef0123456789abcdef';
    const result = parseStashList(out);
    expect(result).toEqual([
      {
        index: 0,
        message: 'WIP on main: 1a2b3c4 fix thing',
        branch: 'main',
        date: '2026-01-02T03:04:05+09:00',
        sha: 'deadbeef0123456789abcdef0123456789abcdef',
      },
    ]);
  });

  it('extracts the branch from an "On <branch>:" subject', () => {
    const out = 'stash@{1}\tOn feature/x: manual stash\t2026-01-01T00:00:00Z\tabc123';
    const result = parseStashList(out);
    expect(result[0].branch).toBe('feature/x');
    expect(result[0].index).toBe(1);
  });

  it('sets branch to null when the subject does not match WIP/On patterns', () => {
    const out = 'stash@{2}\tcustom stash message\t2026-01-01T00:00:00Z\tabc123';
    const result = parseStashList(out);
    expect(result[0].branch).toBeNull();
  });

  it('skips lines whose %gd does not match stash@{N}', () => {
    const out =
      'notastash\tWIP on main: x\t2026-01-01T00:00:00Z\tabc\n' +
      'stash@{0}\tWIP on main: y\t2026-01-01T00:00:00Z\tdef';
    const result = parseStashList(out);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
  });

  it('parses multiple stash rows in order', () => {
    const out =
      'stash@{0}\tWIP on main: a\t2026-01-02T00:00:00Z\tsha0\n' +
      'stash@{1}\tWIP on dev: b\t2026-01-01T00:00:00Z\tsha1';
    const result = parseStashList(out);
    expect(result.map((s) => s.index)).toEqual([0, 1]);
    expect(result[1].branch).toBe('dev');
  });
});

// ============================================================================
// Issue #782: getStashList (read path, best-effort, non-throw)
// ============================================================================

describe('getStashList (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('runs git stash list with the tab-separated format and parses output', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      return { stdout: 'stash@{0}\tWIP on main: a\t2026-01-02T00:00:00Z\tsha0\n' };
    });

    const result = await getStashList('/repo');

    expect(calls[0]).toEqual(['stash', 'list', "--format=%gd%x09%s%x09%cI%x09%H"]);
    expect(result).toHaveLength(1);
    expect(result[0].index).toBe(0);
  });

  it('degrades to [] (non-throw) when the read fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('boom'));
    await expect(getStashList('/repo')).resolves.toEqual([]);
  });
});

// ============================================================================
// Issue #782: stash write operations
// ============================================================================

describe('stash write operations (Issue #782)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('stashPush runs git stash push -- (no options)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await stashPush('/repo', {});
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['stash', 'push', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('stashPush adds --include-untracked and -m <message>', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await stashPush('/repo', { message: 'wip', includeUntracked: true });
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['stash', 'push', '--include-untracked', '-m', 'wip', '--'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('stashPush normalizes "No local changes to save" into GitNothingToStashError', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('No local changes to save'));
    await expect(stashPush('/repo', {})).rejects.toBeInstanceOf(GitNothingToStashError);
  });

  it('stashPop runs git stash pop -- stash@{N}', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    const result = await stashPop('/repo', 2);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['stash', 'pop', '--', 'stash@{2}'],
      expect.objectContaining({ cwd: '/repo' })
    );
    expect(result).toEqual({ conflict: false });
  });

  it('stashApply runs git stash apply -- stash@{N}', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await stashApply('/repo', 0);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['stash', 'apply', '--', 'stash@{0}'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('stashDrop runs git stash drop -- stash@{N}', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await stashDrop('/repo', 3);
    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['stash', 'drop', '--', 'stash@{3}'],
      expect.objectContaining({ cwd: '/repo' })
    );
  });

  it('stashPop recovers conflict via err.stdout (200 conflict, stash retained)', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in src/a.ts\nCONFLICT (content): Merge conflict in src/b.ts\n',
    });
    mockExecFileAsync.mockRejectedValue(err);
    const result = await stashPop('/repo', 0);
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['src/a.ts', 'src/b.ts']);
    expect(result.stashRetained).toBe(true);
  });

  it('stashApply recovers conflict via err.stdout (200 conflict)', async () => {
    const err = Object.assign(new Error('exit 1'), {
      code: 1,
      stdout: 'CONFLICT (content): Merge conflict in src/a.ts\n',
    });
    mockExecFileAsync.mockRejectedValue(err);
    const result = await stashApply('/repo', 0);
    expect(result.conflict).toBe(true);
    expect(result.conflictFiles).toEqual(['src/a.ts']);
  });

  it('stashPop re-throws GitTimeoutError on a killed process', async () => {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    await expect(stashPop('/repo', 0)).rejects.toBeInstanceOf(GitTimeoutError);
  });

  it('stashPop throws GitIndexLockedError when .git/index.lock exists', async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(stashPop('/repo', 0)).rejects.toBeInstanceOf(GitIndexLockedError);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('stashDrop throws GitIndexLockedError when .git/index.lock exists', async () => {
    mockExistsSync.mockReturnValue(true);
    await expect(stashDrop('/repo', 0)).rejects.toBeInstanceOf(GitIndexLockedError);
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });
});

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
// Issue #782: handleGitApiError new reasons + #780/#781 byte-invariant regression
// ============================================================================

describe('handleGitApiError danger-zone reasons (Issue #782)', () => {
  async function bodyOf(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { error?: string; reason?: string };
    return { status: res.status, error: body.error, reason: body.reason };
  }

  it('maps GitNothingToStashError to 400 nothing_to_stash', async () => {
    const result = await bodyOf(new GitNothingToStashError('x'));
    expect(result.status).toBe(400);
    expect(result.reason).toBe('nothing_to_stash');
  });

  it('maps GitResetDefaultBranchError to 409 default_branch (reset-specific message)', async () => {
    const result = await bodyOf(new GitResetDefaultBranchError('x'));
    expect(result.status).toBe(409);
    expect(result.reason).toBe('default_branch');
    // Must NOT reuse the delete-specific "Cannot delete the default branch" text.
    expect(result.error).not.toBe('Cannot delete the default branch');
  });

  // S3-001: the #780/#781 reason bodies must be byte-identical after the additive
  // expansion. These assertions lock the EXACT error string + reason + status.
  it('keeps #780/#781 reason bodies byte-identical (regression)', async () => {
    expect(await bodyOf(new GitIndexLockedError('x'))).toEqual({
      status: 409,
      error: 'Git index is locked by another operation',
      reason: undefined,
    });
    expect(await bodyOf(new GitNothingToCommitError('x'))).toEqual({
      status: 400,
      error: 'Nothing to commit',
      reason: undefined,
    });
    expect(await bodyOf(new GitBranchNotFoundError('x'))).toEqual({
      status: 404,
      error: 'Branch not found',
      reason: 'branch_not_found',
    });
    expect(await bodyOf(new GitBranchNotMergedError('x'))).toEqual({
      status: 409,
      error: 'Branch is not fully merged',
      reason: 'not_merged',
    });
    expect(await bodyOf(new GitCurrentBranchError('x'))).toEqual({
      status: 409,
      error: 'Cannot operate on the current branch',
      reason: 'current_branch',
    });
    expect(await bodyOf(new GitDefaultBranchError('x'))).toEqual({
      status: 409,
      error: 'Cannot delete the default branch',
      reason: 'default_branch',
    });
    expect(await bodyOf(new GitDirtyError('x'))).toEqual({
      status: 409,
      error: 'Working tree has uncommitted changes',
      reason: 'dirty',
    });
    expect(await bodyOf(new GitTimeoutError('x'))).toEqual({
      status: 504,
      error: 'Git command timed out',
      reason: undefined,
    });
    expect(await bodyOf(new GitNotRepoError('x'))).toEqual({
      status: 400,
      error: 'Not a git repository',
      reason: undefined,
    });
  });
});

// ============================================================================
// Issue #783: getDefaultBranch / resolveDefaultBranchName (3-value contract)
// ============================================================================

describe('getDefaultBranch (Issue #783, DR1-002)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns the resolved name when symbolic-ref yields origin/<name>', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main' });
    await expect(getDefaultBranch('/repo')).resolves.toBe('main');
  });

  it('trims a trailing newline (execGitCommand trims) for origin/<name>', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/develop\n' });
    await expect(getDefaultBranch('/repo')).resolves.toBe('develop');
  });

  it('returns DEFAULT_BRANCH_UNRESOLVED when symbolic-ref fails (null)', async () => {
    mockGitByArgs({
      'symbolic-ref': async () => {
        throw new Error('no origin/HEAD');
      },
    });
    await expect(getDefaultBranch('/repo')).resolves.toBe(DEFAULT_BRANCH_UNRESOLVED);
  });

  it('returns null when symbolic-ref yields a non-origin/ value (upstream/main)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'upstream/main' });
    await expect(getDefaultBranch('/repo')).resolves.toBeNull();
  });

  it('returns null when symbolic-ref yields a bare name (main)', async () => {
    mockGitByArgs({ 'symbolic-ref': 'main' });
    await expect(getDefaultBranch('/repo')).resolves.toBeNull();
  });

  it('returns null for an empty-string symbolic-ref value (non-null, non-origin/)', async () => {
    // symbolic-ref returns '' (non-null) -> startsWith('origin/') false -> null
    // (matches the original isDefaultBranchForReset edge: empty -> not protected).
    mockGitByArgs({ 'symbolic-ref': '' });
    await expect(getDefaultBranch('/repo')).resolves.toBeNull();
  });
});

describe('resolveDefaultBranchName (Issue #783)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('returns the resolved name for origin/<name>', async () => {
    mockGitByArgs({ 'symbolic-ref': 'origin/main' });
    await expect(resolveDefaultBranchName('/repo')).resolves.toBe('main');
  });

  it('collapses DEFAULT_BRANCH_UNRESOLVED to null', async () => {
    mockGitByArgs({
      'symbolic-ref': async () => {
        throw new Error('no origin/HEAD');
      },
    });
    await expect(resolveDefaultBranchName('/repo')).resolves.toBeNull();
  });

  it('collapses a non-origin/ value to null', async () => {
    mockGitByArgs({ 'symbolic-ref': 'upstream/main' });
    await expect(resolveDefaultBranchName('/repo')).resolves.toBeNull();
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

// ============================================================================
// Issue #783: deleteBranch default-branch detection consolidation (DR1-001)
// Behavior must be byte-invariant: same default_branch reason / 409 / message,
// and "unresolved = NOT protected" (NO main/master fallback in deleteBranch).
// ============================================================================

describe('deleteBranch default-branch consolidation (Issue #783, DR1-001)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('still rejects deleting the default branch (origin/main\\n trailing-newline boundary)', async () => {
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/x\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });
    await expect(deleteBranch('/repo', { name: 'main' })).rejects.toBeInstanceOf(
      GitDefaultBranchError
    );
    // The branch -d/-D must not run when the default-branch guard fires.
    expect(
      mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'branch' && (c[1].includes('-d') || c[1].includes('-D')))
    ).toBeUndefined();
  });

  it('does NOT protect via main/master fallback when origin/HEAD is unresolved', async () => {
    // symbolic-ref unresolved + deleting "main" -> NO fallback (unlike reset).
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/x\n' };
      if (joined.includes('symbolic-ref')) throw new Error('no origin/HEAD');
      return { stdout: '' };
    });
    await deleteBranch('/repo', { name: 'main' });
    const delCall = calls.find((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D')));
    expect(delCall).toEqual(['branch', '-d', 'main', '--']);
  });

  it('does NOT protect a non-default branch when origin/HEAD resolves elsewhere', async () => {
    const calls: string[][] = [];
    mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
      calls.push(args);
      const joined = args.join(' ');
      if (joined.includes('--abbrev-ref')) return { stdout: 'feature/cur\n' };
      if (joined.includes('symbolic-ref')) return { stdout: 'origin/main\n' };
      return { stdout: '' };
    });
    await deleteBranch('/repo', { name: 'feature/done' });
    const delCall = calls.find((a) => a[0] === 'branch' && (a.includes('-d') || a.includes('-D')));
    expect(delCall).toEqual(['branch', '-d', 'feature/done', '--']);
  });
});

// ============================================================================
// Issue #783: execGitConflictAware timeout param (DR2-007, byte-invariant)
// Exercised through gitRevert (a 2-arg caller -> default 30s -> byte-invariant)
// and through gitPull (Part 2) which will pass a custom timeout. Here we lock
// that the 2-arg callers keep the GIT_WRITE_TIMEOUT_MS default behavior.
// ============================================================================

describe('execGitConflictAware timeout default (Issue #783, DR2-007)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('gitRevert (2-arg caller) keeps the default 30s timeout (byte-invariant)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '' });
    await gitRevert('/repo', { commitHash: 'abc1234' });
    const revertCall = mockExecFileAsync.mock.calls.find((c) => c[1][0] === 'revert');
    expect(revertCall?.[2]).toMatchObject({ timeout: 30000 });
  });

  it('gitRevert (2-arg caller) still re-throws GitTimeoutError on a killed process', async () => {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('killed'), { killed: true }));
    await expect(gitRevert('/repo', { commitHash: 'abc1234' })).rejects.toBeInstanceOf(
      GitTimeoutError
    );
  });
});

// ============================================================================
// Issue #783: 6 network error classes + handleGitApiError extension (DR4-003)
// Additive NEW it() blocks. The existing byte-identical it (L1595) is UNCHANGED.
// Bodies are FIXED literals that never echo error.message (no token/URL leakage).
// ============================================================================

describe('handleGitApiError network reasons (Issue #783, DR4-003)', () => {
  async function bodyOf(error: Error) {
    const res = handleGitApiError(error, 'test');
    const body = (await res.json()) as { error?: string; reason?: string };
    return { status: res.status, error: body.error, reason: body.reason };
  }

  it('maps GitAuthFailedError to 401 auth_failed (fixed body)', async () => {
    expect(await bodyOf(new GitAuthFailedError())).toEqual({
      status: 401,
      error: 'Authentication failed; configure credentials in the terminal',
      reason: 'auth_failed',
    });
  });

  it('maps GitNonFastForwardError to 409 non_fast_forward (fixed body)', async () => {
    expect(await bodyOf(new GitNonFastForwardError())).toEqual({
      status: 409,
      error: 'Push rejected (non-fast-forward); pull/rebase first',
      reason: 'non_fast_forward',
    });
  });

  it('maps GitNoUpstreamError to 400 no_upstream (fixed body)', async () => {
    expect(await bodyOf(new GitNoUpstreamError())).toEqual({
      status: 400,
      error: 'No upstream branch configured',
      reason: 'no_upstream',
    });
  });

  it('maps GitProtectedBranchError to 409 protected_branch (fixed body)', async () => {
    expect(await bodyOf(new GitProtectedBranchError())).toEqual({
      status: 409,
      error: 'Force push to the default branch is not allowed',
      reason: 'protected_branch',
    });
  });

  it('maps GitForceWithLeaseStaleError to 409 force_with_lease_stale (fixed body)', async () => {
    expect(await bodyOf(new GitForceWithLeaseStaleError())).toEqual({
      status: 409,
      error: 'Stale info; remote has new commits',
      reason: 'force_with_lease_stale',
    });
  });

  it('maps GitNetworkError to 502 network (fixed body)', async () => {
    expect(await bodyOf(new GitNetworkError())).toEqual({
      status: 502,
      error: 'Could not reach the remote',
      reason: 'network',
    });
  });

  it('never echoes a stderr/message into the HTTP body (no token/URL leakage)', async () => {
    // Even if a class were constructed with a sensitive message, the fixed body
    // must not include it. The classes take no message arg, but assert anyway.
    const leak = 'https://ci-bot:glpat-SECRET@gitlab/repo.git';
    const err = Object.assign(new GitNetworkError(), { message: leak });
    const result = await bodyOf(err);
    expect(result.error).toBe('Could not reach the remote');
    expect(JSON.stringify(result)).not.toContain('glpat-SECRET');
    expect(JSON.stringify(result)).not.toContain('ci-bot');
  });

  // DR3-003: an EXTENDED byte-identical it for the 6 NEW classes (separate from
  // the existing L1595 it, which stays byte-unchanged).
  it('locks the 6 #783 network reason bodies byte-identical (extended regression)', async () => {
    expect(await bodyOf(new GitAuthFailedError())).toEqual({
      status: 401,
      error: 'Authentication failed; configure credentials in the terminal',
      reason: 'auth_failed',
    });
    expect(await bodyOf(new GitNonFastForwardError())).toEqual({
      status: 409,
      error: 'Push rejected (non-fast-forward); pull/rebase first',
      reason: 'non_fast_forward',
    });
    expect(await bodyOf(new GitNoUpstreamError())).toEqual({
      status: 400,
      error: 'No upstream branch configured',
      reason: 'no_upstream',
    });
    expect(await bodyOf(new GitProtectedBranchError())).toEqual({
      status: 409,
      error: 'Force push to the default branch is not allowed',
      reason: 'protected_branch',
    });
    expect(await bodyOf(new GitForceWithLeaseStaleError())).toEqual({
      status: 409,
      error: 'Stale info; remote has new commits',
      reason: 'force_with_lease_stale',
    });
    expect(await bodyOf(new GitNetworkError())).toEqual({
      status: 502,
      error: 'Could not reach the remote',
      reason: 'network',
    });
  });
});

// ============================================================================
// Issue #783: execGitCommandTyped preserve regex is NOT modified (DR2-001).
// network/auth patterns must NOT be added to the preserve-list — that is Part 2's
// classifyNetworkStderr job. This asserts the source text of the preserve regex.
// ============================================================================

describe('execGitCommandTyped preserve regex invariant (Issue #783, DR2-001)', () => {
  it('does not add network/auth patterns to the preserve-list', async () => {
    // `fs` is vi.mock'd at module scope, so read the real source via importActual.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const realPath = await vi.importActual<typeof import('path')>('path');
    const src = realFs.readFileSync(
      realPath.join(process.cwd(), 'src/lib/git/git-utils.ts'),
      'utf-8'
    );
    // Slice ONLY the execGitCommandTyped function body so the assertion targets
    // the preserve-list regex specifically (not the #783 network error classes /
    // bodies elsewhere in the file, which legitimately mention "non-fast-forward").
    const start = src.indexOf('async function execGitCommandTyped(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('async function parseGitLogOutput', start) > -1
      ? src.indexOf('function parseGitLogOutput', start)
      : src.indexOf('function parseGitLogOutput', start);
    expect(end).toBeGreaterThan(start);
    const fn = src.slice(start, end);

    // The #781 branch-operation preserve regex must be present and unchanged.
    expect(fn).toContain(
      "/did not match|not a valid ref|not found|invalid reference|not fully merged|couldn't find remote ref/i"
    );
    // Network/auth patterns must NOT have been spliced into execGitCommandTyped's
    // preserve-list (they belong in classifyNetworkStderr in Part 2 — DR2-001).
    expect(fn).not.toMatch(/Authentication failed|could not read Username/);
    expect(fn).not.toMatch(/non-fast-forward/);
    expect(fn).not.toMatch(/Could not resolve host|stale info|has no upstream/i);
  });
});

// ============================================================================
// Issue #783 (Part 2): classifyNetworkStderr — single source mapping raw git
// stderr -> the 6 typed network errors (DR2-001 / DR4-003). CRITICAL: the typed
// errors are constructed WITHOUT a stderr/message arg, so raw stderr (which may
// contain a token-bearing URL) never reaches the thrown error.
// ============================================================================

describe('classifyNetworkStderr (Issue #783, DR2-001/DR4-003)', () => {
  it('maps "Authentication failed" to GitAuthFailedError', () => {
    expect(classifyNetworkStderr('fatal: Authentication failed for https://x')).toBeInstanceOf(
      GitAuthFailedError
    );
  });

  it('maps "could not read Username" to GitAuthFailedError', () => {
    expect(classifyNetworkStderr('fatal: could not read Username for https://x')).toBeInstanceOf(
      GitAuthFailedError
    );
  });

  it('maps "! [rejected] ... (fetch first)" to GitNonFastForwardError', () => {
    expect(
      classifyNetworkStderr(' ! [rejected]        main -> main (fetch first)')
    ).toBeInstanceOf(GitNonFastForwardError);
  });

  it('maps "non-fast-forward" to GitNonFastForwardError', () => {
    expect(classifyNetworkStderr('error: failed to push some refs (non-fast-forward)')).toBeInstanceOf(
      GitNonFastForwardError
    );
  });

  it('maps "has no upstream branch" to GitNoUpstreamError', () => {
    expect(
      classifyNetworkStderr('fatal: The current branch feature has no upstream branch.')
    ).toBeInstanceOf(GitNoUpstreamError);
  });

  it('maps "no upstream" to GitNoUpstreamError', () => {
    expect(classifyNetworkStderr('fatal: no upstream configured')).toBeInstanceOf(
      GitNoUpstreamError
    );
  });

  it('maps "stale info" to GitForceWithLeaseStaleError', () => {
    expect(
      classifyNetworkStderr('! [rejected] main -> main (stale info)')
    ).toBeInstanceOf(GitForceWithLeaseStaleError);
  });

  it('maps "Could not resolve host" to GitNetworkError', () => {
    expect(classifyNetworkStderr('fatal: unable to access ...: Could not resolve host: github.com')).toBeInstanceOf(
      GitNetworkError
    );
  });

  it('maps "unable to access" to GitNetworkError', () => {
    expect(classifyNetworkStderr("fatal: unable to access 'https://host/repo'")).toBeInstanceOf(
      GitNetworkError
    );
  });

  it('falls back to a generic Error for unknown stderr', () => {
    const e = classifyNetworkStderr('some completely unknown failure');
    expect(e).toBeInstanceOf(Error);
    expect(e).not.toBeInstanceOf(GitAuthFailedError);
    expect(e).not.toBeInstanceOf(GitNetworkError);
    expect(e.message).toBe('Failed to execute git command');
  });

  it('prioritizes stale info (force-with-lease) over non-fast-forward when both appear', () => {
    // git prints "stale info" alongside "[rejected]" for a force-with-lease miss.
    expect(
      classifyNetworkStderr('! [rejected] main -> main (stale info)\n(non-fast-forward)')
    ).toBeInstanceOf(GitForceWithLeaseStaleError);
  });

  it('NEVER places raw stderr / a token-bearing URL on the thrown error message', () => {
    const leak = "fatal: unable to access 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    const e = classifyNetworkStderr(leak);
    expect(e).toBeInstanceOf(GitNetworkError);
    expect(e.message).not.toContain('glpat-SECRET');
    expect(e.message).not.toContain('ci-bot');
    expect(e.message).not.toContain('https://');
  });

  it('NEVER places a token-bearing URL on an auth-failed error message', () => {
    const leak =
      "fatal: Authentication failed for 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    const e = classifyNetworkStderr(leak);
    expect(e).toBeInstanceOf(GitAuthFailedError);
    expect(e.message).not.toContain('glpat-SECRET');
    expect(e.message).not.toContain('ci-bot');
  });
});

// ============================================================================
// Issue #783 (Part 2): gitFetch / gitPull / gitPush network operations.
// execGitNetworkAware is exercised through gitFetch / gitPush (it is not
// exported). gitPull goes through execGitConflictAware (timeout param).
// ============================================================================

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
