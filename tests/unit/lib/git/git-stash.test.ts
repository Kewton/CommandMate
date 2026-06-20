/**
 * Tests for git-stash.ts (list + push / pop / apply / drop).
 * Issue #782 (originally in git-utils.test.ts).
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

import {
  parseStashList,
  getStashList,
  stashPush,
  stashPop,
  stashApply,
  stashDrop,
} from '@/lib/git/git-stash';
import { GitNothingToStashError, GitTimeoutError, GitIndexLockedError } from '@/lib/git/git-errors';

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
