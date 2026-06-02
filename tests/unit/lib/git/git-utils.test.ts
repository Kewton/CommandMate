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
  GitIndexLockedError,
  GitNothingToCommitError,
  GitTimeoutError,
  GitNotRepoError,
} from '@/lib/git/git-utils';

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
