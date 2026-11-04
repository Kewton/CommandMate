/**
 * Issue #4134: "not a repository" is an answer, a failed git is not.
 *
 * @vitest-environment node
 */
import { execFileSync } from 'child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const exec = vi.hoisted(() => ({ override: null as null | { ok: boolean; stdout: string; stderr: string; timedOut: boolean } }));
vi.mock('@/lib/git/git-exec', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/git/git-exec')>();
  return {
    ...actual,
    execGitCommandCapture: (...args: Parameters<typeof actual.execGitCommandCapture>) =>
      exec.override ? Promise.resolve(exec.override) : actual.execGitCommandCapture(...args),
  };
});

import { probeGitCommonDir, resolveGitCommonDir } from '@/lib/git/git-common-dir';

describe('probeGitCommonDir', () => {
  let sandbox: string;

  beforeEach(() => {
    exec.override = null;
    sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'git-probe-4134-')));
  });

  afterEach(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  it('a repository answers with its common dir', async () => {
    const repo = join(sandbox, 'repo');
    mkdirSync(repo);
    execFileSync('git', ['init', '-q', repo]);
    expect(await probeGitCommonDir(repo)).toEqual({ kind: 'repository', commonDir: join(repo, '.git') });
  });

  it('a directory git says is no repository is "not-repository"', async () => {
    expect(await probeGitCommonDir(sandbox)).toEqual({ kind: 'not-repository' });
  });

  it('the mount-point wording is the same answer', async () => {
    exec.override = {
      ok: false,
      stdout: '',
      stderr: 'fatal: not a git repository (or any parent up to mount point /mnt)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).',
      timedOut: false,
    };
    expect(await probeGitCommonDir(sandbox)).toEqual({ kind: 'not-repository' });
  });

  describe('everything else stays a failure, the safe side', () => {
    it('a timeout, even with the wording in its message', async () => {
      exec.override = { ok: false, stdout: '', stderr: 'not a git repository (or any of the parent directories)', timedOut: true };
      expect(await probeGitCommonDir(sandbox)).toEqual({ kind: 'failed' });
    });

    it('a directory that is gone', async () => {
      expect(await probeGitCommonDir(join(sandbox, 'nope'))).toEqual({ kind: 'failed' });
    });

    it('a linked worktree whose repository is gone: it was a member, and git cannot say of what', async () => {
      const broken = join(sandbox, 'broken');
      mkdirSync(broken);
      writeFileSync(join(broken, '.git'), `gitdir: ${join(sandbox, 'gone', '.git', 'worktrees', 'x')}\n`);
      expect(await probeGitCommonDir(broken)).toEqual({ kind: 'failed' });
    });

    it('a repository whose config git refuses', async () => {
      const repo = join(sandbox, 'bad-config');
      mkdirSync(repo);
      execFileSync('git', ['init', '-q', repo]);
      writeFileSync(join(repo, '.git', 'config'), '[core\n');
      expect(await probeGitCommonDir(repo)).toEqual({ kind: 'failed' });
    });

    it('a success with nothing printed', async () => {
      exec.override = { ok: true, stdout: '', stderr: '', timedOut: false };
      expect(await probeGitCommonDir(sandbox)).toEqual({ kind: 'failed' });
    });
  });

  it('resolveGitCommonDir keeps its one answer, null for both', async () => {
    expect(await resolveGitCommonDir(sandbox)).toBeNull();
    exec.override = { ok: false, stdout: '', stderr: 'x', timedOut: true };
    expect(await resolveGitCommonDir(sandbox)).toBeNull();
  });
});
