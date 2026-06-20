/**
 * Tests for git-branches.ts (list / checkout / create / delete + parse helpers).
 * Issue #781 / #783 (originally in git-utils.test.ts).
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
  listBranches,
  parseWorktreePorcelain,
  parseForEachRefTracking,
  checkoutBranch,
  createBranch,
  deleteBranch,
} from '@/lib/git/git-branches';
import {
  GitBranchNotFoundError,
  GitBranchNotMergedError,
  GitBranchCheckedOutElsewhereError,
  GitDirtyError,
  GitCurrentBranchError,
  GitDefaultBranchError,
} from '@/lib/git/git-errors';

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
