/**
 * Tests for git-exec.ts (write serialization + exec wrappers).
 * Issue #780 / #783 (originally in git-utils.test.ts).
 * Issue #921: split out of git-utils.test.ts to follow the new module boundary.
 *
 * The exec helpers (runSerializedWrite / execGitConflictAware /
 * execGitCommandTyped) are exercised through their callers (stageFiles,
 * gitRevert), which is how they were tested in the original suite.
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

import { stageFiles } from '@/lib/git/git-commit';
import { gitRevert } from '@/lib/git/git-reset';
import { GitTimeoutError } from '@/lib/git/git-errors';

// ============================================================================
// Issue #780: write serialization (runSerializedWrite, via stageFiles)
// ============================================================================

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
// Issue #783: execGitConflictAware timeout param (DR2-007, byte-invariant)
// Exercised through gitRevert (a 2-arg caller -> default 30s -> byte-invariant).
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
// Issue #783: execGitCommandTyped preserve regex is NOT modified (DR2-001).
// network/auth patterns must NOT be added to the preserve-list — that is Part 2's
// classifyNetworkStderr job. This asserts the source text of the preserve regex.
// Issue #921: execGitCommandTyped now lives in git-exec.ts; the slice end marker
// is `const writeChains` (the next declaration after execGitCommandTyped).
// ============================================================================

describe('execGitCommandTyped preserve regex invariant (Issue #783, DR2-001)', () => {
  it('does not add network/auth patterns to the preserve-list', async () => {
    // `fs` is vi.mock'd at module scope, so read the real source via importActual.
    const realFs = await vi.importActual<typeof import('fs')>('fs');
    const realPath = await vi.importActual<typeof import('path')>('path');
    const src = realFs.readFileSync(
      realPath.join(process.cwd(), 'src/lib/git/git-exec.ts'),
      'utf-8'
    );
    // Slice ONLY the execGitCommandTyped function body so the assertion targets
    // the preserve-list regex specifically (not the #783 network error classes /
    // bodies elsewhere, which legitimately mention "non-fast-forward").
    const start = src.indexOf('async function execGitCommandTyped(');
    expect(start).toBeGreaterThan(-1);
    const end = src.indexOf('const writeChains', start);
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
