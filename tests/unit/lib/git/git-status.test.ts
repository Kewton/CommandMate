/**
 * Tests for git-status.ts (porcelain status / staged status / getGitStatus).
 * Issue #780 / #781 (originally in git-utils.test.ts).
 * Issue #921: split out of git-utils.test.ts to follow the new module boundary.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions so they are available in vi.mock() factories
const { mockExistsSync, mockExecFileAsync, mockStat, mockLogger } = vi.hoisted(() => ({
  mockExistsSync: vi.fn(),
  mockExecFileAsync: vi.fn(),
  mockStat: vi.fn(),
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

// Issue #1515 (A-3): getLastFetchAt stats FETCH_HEAD through fs/promises.
vi.mock('fs/promises', () => ({
  stat: (...args: unknown[]) => mockStat(...args),
}));

vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  parsePorcelainStatus,
  getStagedStatus,
  getGitStatus,
  getAheadBehind,
  getLastFetchAt,
} from '@/lib/git/git-status';

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
// Issue #780: getStagedStatus
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
// Issue #1515 (B-1): getAheadBehind classifies WHY the counts are missing
// ============================================================================

describe('getAheadBehind reason classification (Issue #1515, B-1)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  /** Reject the way execFile does: stderr on the error object. */
  function rejectWithStderr(stderr: string, extra: Record<string, unknown> = {}) {
    mockExecFileAsync.mockRejectedValue(Object.assign(new Error('exit 128'), { stderr, ...extra }));
  }

  it('returns the counts and reason=null on success', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '1\t2\n', stderr: '' });

    const result = await getAheadBehind('/repo');

    expect(result).toEqual({ aheadBehind: { ahead: 2, behind: 1 }, reason: null });
  });

  // Wordings measured against git 2.49 (see the doc comment on the classifier).
  it.each([
    ["fatal: no upstream configured for branch 'feature/x'", 'no_upstream'],
    ['fatal: HEAD does not point to a branch', 'detached'],
    [
      "fatal: ambiguous argument '@{upstream}...HEAD': unknown revision or path not in the working tree.",
      'upstream_gone',
    ],
    ['fatal: something nobody has ever seen', 'error'],
  ])('classifies %s as %s', async (stderr, expected) => {
    rejectWithStderr(stderr);

    const result = await getAheadBehind('/repo');

    expect(result).toEqual({ aheadBehind: null, reason: expected });
  });

  it('classifies a timeout as error (never as a git-state reason)', async () => {
    // A killed process can still have "no upstream" text in its message; the
    // timeout check must win so a slow repo is not reported as "not pushed".
    rejectWithStderr('no upstream configured', { killed: true });

    const result = await getAheadBehind('/repo');

    expect(result).toEqual({ aheadBehind: null, reason: 'error' });
  });

  it.each([
    ['1 2', 'wrong separator'],
    ['1\t2\t3', 'too many fields'],
    ['abc\txyz', 'non-integer'],
    ['', 'empty'],
  ])('maps unparsable output (%s: %s) to reason=error', async (stdout) => {
    mockExecFileAsync.mockResolvedValue({ stdout, stderr: '' });

    const result = await getAheadBehind('/repo');

    expect(result).toEqual({ aheadBehind: null, reason: 'error' });
  });

  it('never leaks git stderr (only the classified enum is returned or logged)', async () => {
    const leak = "fatal: unable to access 'https://ci-bot:glpat-SECRET@gitlab/repo.git'";
    rejectWithStderr(leak);

    const result = await getAheadBehind('/repo');

    expect(JSON.stringify(result)).not.toContain('glpat-SECRET');
    const logged = JSON.stringify([
      ...mockLogger.debug.mock.calls,
      ...mockLogger.info.mock.calls,
      ...mockLogger.warn.mock.calls,
      ...mockLogger.error.mock.calls,
    ]);
    expect(logged).not.toContain('glpat-SECRET');
    expect(logged).not.toContain('ci-bot');
  });

  it('never throws', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('catastrophic git failure'));

    await expect(getAheadBehind('/repo')).resolves.toEqual({
      aheadBehind: null,
      reason: 'error',
    });
  });
});

// ============================================================================
// Issue #1515 (A-3): getLastFetchAt — how old the compared snapshot is
// ============================================================================

describe('getLastFetchAt (Issue #1515, A-3)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(false);
  });

  it('asks git for both FETCH_HEAD paths and returns the mtime', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '.git/FETCH_HEAD\n.git\n', stderr: '' });
    mockStat.mockResolvedValue({ mtimeMs: 1_700_000_000_123 });

    const result = await getLastFetchAt('/repo');

    expect(mockExecFileAsync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--git-path', 'FETCH_HEAD', '--git-common-dir'],
      expect.objectContaining({ cwd: '/repo' })
    );
    // Normal repo: both candidates resolve to the same file -> stat'd once.
    expect(mockStat).toHaveBeenCalledTimes(1);
    expect(mockStat).toHaveBeenCalledWith('/repo/.git/FETCH_HEAD');
    expect(result).toBe(1_700_000_000_123);
  });

  it('takes the NEWEST of the linked-worktree and common-dir FETCH_HEAD', async () => {
    // A linked worktree gets absolute paths from `rev-parse --git-path`; a fetch
    // run in the repo root only touches the common-dir file, so both matter.
    mockExecFileAsync.mockResolvedValue({
      stdout: '/repo/.git/worktrees/wt/FETCH_HEAD\n/repo/.git\n',
      stderr: '',
    });
    mockStat.mockImplementation(async (target: string) =>
      target === '/repo/.git/FETCH_HEAD' ? { mtimeMs: 2000 } : { mtimeMs: 1000 }
    );

    const result = await getLastFetchAt('/repo/wt');

    expect(mockStat).toHaveBeenCalledTimes(2);
    expect(result).toBe(2000);
  });

  it('returns null when FETCH_HEAD does not exist (never fetched)', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '.git/FETCH_HEAD\n.git\n', stderr: '' });
    mockStat.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    await expect(getLastFetchAt('/repo')).resolves.toBeNull();
  });

  it('returns null (never throws) when the git call fails', async () => {
    mockExecFileAsync.mockRejectedValue(new Error('not a git repository'));

    await expect(getLastFetchAt('/repo')).resolves.toBeNull();
    expect(mockStat).not.toHaveBeenCalled();
  });

  it('returns null when git prints nothing usable', async () => {
    mockExecFileAsync.mockResolvedValue({ stdout: '\n', stderr: '' });

    await expect(getLastFetchAt('/repo')).resolves.toBeNull();
  });
});
