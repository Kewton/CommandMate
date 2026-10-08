/**
 * Issue #3435: a failed `git status --porcelain` (typically the 1s read
 * timeout under load) must not be reported as a clean working tree.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockExecFileAsync, mockLogger } = vi.hoisted(() => ({
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
  return { createLogger: vi.fn(() => mockLogger) };
});

vi.mock('child_process', () => ({ execFile: vi.fn() }));
vi.mock('util', () => ({ promisify: () => mockExecFileAsync }));

import { getGitStatus } from '@/lib/git/git-status';
import { readSkillGitTargetState } from '@/lib/skills/preview-diff';

/** execFile rejects the way a timeout kill does. */
function timeoutError(): Error {
  return Object.assign(new Error('Command failed: git status --porcelain'), {
    killed: true,
    signal: 'SIGTERM',
    code: null,
  });
}

function stubGit(statusResult: { stdout: string } | Error, extra: Record<string, string> = {}) {
  mockExecFileAsync.mockImplementation(async (_file: string, args: string[]) => {
    const joined = args.join(' ');
    if (joined === 'status --porcelain') {
      if (statusResult instanceof Error) throw statusResult;
      return statusResult;
    }
    for (const [key, stdout] of Object.entries(extra)) {
      if (joined.includes(key)) return { stdout };
    }
    if (joined.includes('--abbrev-ref')) return { stdout: 'main\n' };
    if (joined.includes('--short HEAD')) return { stdout: 'abc1234\n' };
    return { stdout: '' };
  });
}

describe('getGitStatus when status cannot be read (Issue #3435)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports statusUnknown (not clean) when status --porcelain times out', async () => {
    stubGit(timeoutError());

    const status = await getGitStatus('/repo', 'main');

    expect(status.statusUnknown).toBe(true);
    // isDirty stays boolean for existing readers; it carries no information here.
    expect(status.isDirty).toBe(false);
    expect(status.currentBranch).toBe('main');
  });

  it('keeps a clean tree byte-identical (no statusUnknown key)', async () => {
    stubGit({ stdout: '' });

    const status = await getGitStatus('/repo', 'main');

    expect(status).toEqual({
      currentBranch: 'main',
      initialBranch: 'main',
      isBranchMismatch: false,
      commitHash: 'abc1234',
      isDirty: false,
    });
    expect('statusUnknown' in status).toBe(false);
  });

  it('keeps a dirty tree as dirty (no statusUnknown key)', async () => {
    stubGit({ stdout: ' M src/a.ts\n' });

    const status = await getGitStatus('/repo', 'main');

    expect(status.isDirty).toBe(true);
    expect('statusUnknown' in status).toBe(false);
  });
});

describe('readSkillGitTargetState when status cannot be read (Issue #3435)', () => {
  const sha = 'a'.repeat(40);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('treats a failed status as dirty (fail-safe), never as clean', async () => {
    stubGit(timeoutError(), { 'symbolic-ref': 'main\n', 'rev-parse HEAD': `${sha}\n` });

    const state = await readSkillGitTargetState('/repo');

    expect(state.dirty).toBe(true);
    expect(state.headState).toBe('attached');
  });

  it('keeps clean and dirty unchanged on success', async () => {
    stubGit({ stdout: '' }, { 'symbolic-ref': 'main\n', 'rev-parse HEAD': `${sha}\n` });
    expect((await readSkillGitTargetState('/repo')).dirty).toBe(false);

    stubGit({ stdout: '?? new.ts\n' }, { 'symbolic-ref': 'main\n', 'rev-parse HEAD': `${sha}\n` });
    expect((await readSkillGitTargetState('/repo')).dirty).toBe(true);
  });
});
