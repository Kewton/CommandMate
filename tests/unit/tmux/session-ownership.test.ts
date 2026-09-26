/**
 * Issue #2865: a tmux session is this worktree's only when its
 * `#{session_path}` is the worktree's own directory.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const hasSession = vi.fn(async (_name: string) => false);
const getSessionWorkingDirectory = vi.fn(async (_name: string): Promise<string | null> => null);
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: (name: string) => hasSession(name),
  getSessionWorkingDirectory: (name: string) => getSessionWorkingDirectory(name),
}));

const warn = vi.fn();
vi.mock('@/lib/logger', () => ({
  createLogger: () => {
    const mockLogger: Record<string, unknown> = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: (...args: unknown[]) => warn(...(args as [])),
      error: vi.fn(),
      withContext: vi.fn(() => mockLogger),
    };
    return mockLogger;
  },
}));

import {
  FOREIGN_SESSION_ERROR_CODE,
  ForeignSessionError,
  assertSessionNotForeign,
  checkSessionOwnership,
  isSessionPathOwnedBy,
  ownedSessionNameSet,
  resetForeignSessionWarningsForTesting,
} from '@/lib/tmux/session-ownership';

let tmpRoot: string;
let realDir: string;
let linkDir: string;
let otherDir: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-ownership-2865-'));
  realDir = path.join(tmpRoot, 'real-wt');
  otherDir = path.join(tmpRoot, 'other-wt');
  linkDir = path.join(tmpRoot, 'link-wt');
  fs.mkdirSync(realDir);
  fs.mkdirSync(otherDir);
  fs.symlinkSync(realDir, linkDir);
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

beforeEach(() => {
  vi.clearAllMocks();
  hasSession.mockResolvedValue(false);
  getSessionWorkingDirectory.mockResolvedValue(null);
  resetForeignSessionWarningsForTesting();
});

describe('isSessionPathOwnedBy', () => {
  it('is true for the same path', () => {
    expect(isSessionPathOwnedBy(realDir, realDir)).toBe(true);
  });

  it('ignores a trailing slash on either side', () => {
    expect(isSessionPathOwnedBy(`${realDir}/`, realDir)).toBe(true);
    expect(isSessionPathOwnedBy(realDir, `${realDir}/`)).toBe(true);
  });

  it('is true through a symlink (both sides realpath-normalized)', () => {
    expect(isSessionPathOwnedBy(linkDir, realDir)).toBe(true);
    expect(isSessionPathOwnedBy(realDir, linkDir)).toBe(true);
  });

  it('is false for a different directory', () => {
    expect(isSessionPathOwnedBy(otherDir, realDir)).toBe(false);
  });

  it('is false when tmux could not say (null)', () => {
    expect(isSessionPathOwnedBy(null, realDir)).toBe(false);
  });

  it('compares non-existent paths as resolved strings', () => {
    expect(isSessionPathOwnedBy('/nonexistent-2865/a/wt', '/nonexistent-2865/a/wt/')).toBe(true);
    expect(isSessionPathOwnedBy('/nonexistent-2865/a/wt', '/nonexistent-2865/b/wt')).toBe(false);
  });

  it('keeps case significant', () => {
    expect(isSessionPathOwnedBy('/nonexistent-2865/Repo', '/nonexistent-2865/repo')).toBe(false);
  });
});

describe('checkSessionOwnership', () => {
  it('is absent when the session does not exist', async () => {
    hasSession.mockResolvedValue(false);

    await expect(checkSessionOwnership('mcbd-claude-wt', realDir)).resolves.toEqual({
      verdict: 'absent',
      sessionPath: null,
    });
    expect(getSessionWorkingDirectory).not.toHaveBeenCalled();
  });

  it('is owned when session_path matches the worktree path', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(realDir);

    await expect(checkSessionOwnership('mcbd-claude-wt', realDir)).resolves.toEqual({
      verdict: 'owned',
      sessionPath: realDir,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('is foreign when session_path is another directory', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(otherDir);

    await expect(checkSessionOwnership('mcbd-claude-wt', realDir)).resolves.toEqual({
      verdict: 'foreign',
      sessionPath: otherDir,
    });
  });

  it('is foreign when the session exists but session_path cannot be read (fail safe)', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(null);

    await expect(checkSessionOwnership('mcbd-claude-wt', realDir)).resolves.toEqual({
      verdict: 'foreign',
      sessionPath: null,
    });
  });

  it('warns once per foreign session name, not on every check', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(otherDir);

    await checkSessionOwnership('mcbd-claude-wt', realDir);
    await checkSessionOwnership('mcbd-claude-wt', realDir);
    await checkSessionOwnership('mcbd-claude-wt', realDir);

    const foreignWarnings = () => warn.mock.calls.filter(([action]) => action === 'session:foreign-detected');
    expect(foreignWarnings()).toEqual([
      [
        'session:foreign-detected',
        { sessionName: 'mcbd-claude-wt', sessionPath: otherDir, worktreePath: realDir },
      ],
    ]);

    // A different name is reported on its own.
    await checkSessionOwnership('mcbd-codex-wt', realDir);
    expect(foreignWarnings()).toHaveLength(2);
  });
});

describe('assertSessionNotForeign', () => {
  it('throws ForeignSessionError for a foreign session', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(otherDir);

    const error = await assertSessionNotForeign('mcbd-claude-wt', realDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ForeignSessionError);
    expect(error).toMatchObject({
      code: FOREIGN_SESSION_ERROR_CODE,
      sessionName: 'mcbd-claude-wt',
      sessionPath: otherDir,
      worktreePath: realDir,
    });
  });

  it('passes an owned or absent session through', async () => {
    hasSession.mockResolvedValue(true);
    getSessionWorkingDirectory.mockResolvedValue(realDir);
    await expect(assertSessionNotForeign('mcbd-claude-wt', realDir)).resolves.toMatchObject({ verdict: 'owned' });

    hasSession.mockResolvedValue(false);
    await expect(assertSessionNotForeign('mcbd-claude-wt', realDir)).resolves.toMatchObject({ verdict: 'absent' });
  });
});

describe('ownedSessionNameSet', () => {
  it('keeps only the sessions created in the worktree directory', () => {
    const owned = ownedSessionNameSet(
      [
        { name: 'mcbd-claude-wt', path: realDir },
        { name: 'mcbd-codex-wt', path: otherDir },
        { name: 'mcbd-gemini-wt', path: '' },
        { name: 'mcbd-copilot-wt', path: linkDir },
      ],
      realDir
    );

    expect([...owned].sort()).toEqual(['mcbd-claude-wt', 'mcbd-copilot-wt']);
  });
});
