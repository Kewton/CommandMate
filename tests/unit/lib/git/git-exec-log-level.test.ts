/**
 * Issue #3416: execGitCommand log level against a REAL git binary.
 *
 * Production measured 127 `git:command-failed` ERRORs over ~3 days; 126 were
 * `status --porcelain` and 1 `rev-parse --abbrev-ref HEAD`, all with an empty
 * stderr, i.e. children killed by the 1s timeout. Those are expected on a loaded
 * host (callers degrade null to '(unknown)' / not dirty) and must be a warn,
 * while a genuine git failure (non-zero exit) must stay an ERROR.
 *
 * Uses throw-away repositories under os.tmpdir(); the real repo is never touched.
 */

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const { mockLogger } = vi.hoisted(() => ({
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

import { execGitCommand } from '@/lib/git/git-exec';

let root: string;
let repo: string;
let notRepo: string;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'cm-3416-'));
  repo = path.join(root, 'repo');
  notRepo = path.join(root, 'plain');
  fs.mkdirSync(repo);
  fs.mkdirSync(notRepo);
  execFileSync('git', ['init', '-q'], { cwd: repo });
  // Keep `plain` from resolving to an enclosing repository.
  fs.writeFileSync(path.join(notRepo, '.git'), 'gitdir: /nonexistent\n');
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('execGitCommand log level (Issue #3416)', () => {
  it('logs a timed-out read as warn (not ERROR) and still returns null', async () => {
    // A shell alias that outlives the 1s timeout; its output goes to /dev/null so
    // the pipes close as soon as git is killed.
    const out = await execGitCommand(
      ['-c', 'alias.slow=!sleep 3 >/dev/null 2>&1', 'slow'],
      repo
    );

    expect(out).toBeNull();
    expect(mockLogger.error).not.toHaveBeenCalled();
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'git:command-failed',
      expect.objectContaining({ timedOut: true, timeoutMs: 1000, worktree: 'repo' })
    );
  }, 10000);

  it('keeps a genuine git failure (unknown revision) as ERROR', async () => {
    const out = await execGitCommand(['rev-parse', '--verify', 'no-such-ref'], repo);

    expect(out).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).toHaveBeenCalledWith(
      'git:command-failed',
      expect.objectContaining({ args: 'rev-parse --verify no-such-ref', worktree: 'repo' })
    );
    expect(mockLogger.error.mock.calls[0][1]).not.toHaveProperty('timedOut');
  });

  it('keeps a path that is not a repository as ERROR', async () => {
    const out = await execGitCommand(['status', '--porcelain'], notRepo);

    expect(out).toBeNull();
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).toHaveBeenCalledWith(
      'git:command-failed',
      expect.objectContaining({ args: 'status --porcelain' })
    );
  });

  it('logs nothing when the command succeeds', async () => {
    const out = await execGitCommand(['status', '--porcelain'], repo);

    expect(out).toBe('');
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
