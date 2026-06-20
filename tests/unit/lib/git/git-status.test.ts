/**
 * Tests for git-status.ts (porcelain status / staged status / getGitStatus).
 * Issue #780 / #781 (originally in git-utils.test.ts).
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

import { parsePorcelainStatus, getStagedStatus, getGitStatus } from '@/lib/git/git-status';

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
