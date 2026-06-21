/**
 * Tests for git-default-branch.ts (getDefaultBranch / resolveDefaultBranchName).
 * Issue #783 (originally in git-utils.test.ts).
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
  getDefaultBranch,
  resolveDefaultBranchName,
  DEFAULT_BRANCH_UNRESOLVED,
} from '@/lib/git/git-default-branch';

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
