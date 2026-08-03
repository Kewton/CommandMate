/**
 * Scan-root identity (Issue #1662).
 *
 * These tests run against REAL git repositories in a sandbox rather than a
 * mocked `execFile`. The whole claim under test is a claim about what git
 * actually prints — that `--git-common-dir` is shared by every worktree of one
 * repository, is relative from a main checkout and absolute from a linked one,
 * and fails on a non-repository. Mocking git would only assert that the module
 * parses the strings this file would have had to invent anyway.
 *
 * The sandbox lives under `os.tmpdir()`, which on macOS is itself reached
 * through a symlink (`/var` -> `/private/var`). That is not incidental: the
 * #1659 pair had worktrees under `/tmp`, and lexical comparison would have
 * missed them. Running here means the realpath normalization is exercised on
 * every assertion instead of only in the one test that names it.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import {
  resolveGitCommonDir,
  resolveGitCommonDirs,
  findDuplicateScanRoots,
  findScanRootsSharingGitRepository,
} from '@/lib/git/git-common-dir';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

/** A git repository with one commit, so `git worktree add` has something to branch from. */
function initRepository(repoPath: string): string {
  mkdirSync(repoPath, { recursive: true });
  git(repoPath, 'init', '--quiet', '--initial-branch=main');
  writeFileSync(path.join(repoPath, 'README.md'), '# test\n');
  git(repoPath, 'add', 'README.md');
  git(repoPath, 'commit', '--quiet', '-m', 'init');
  return repoPath;
}

let sandbox: string;
/** Main checkout of repository A. */
let repoA: string;
/** Linked worktree of repository A — a DIFFERENT directory, the SAME repository. */
let repoAWorktree: string;
/** A second linked worktree of repository A. */
let repoAWorktree2: string;
/** Main checkout of an unrelated repository B. */
let repoB: string;
/** A plain directory that is not a git repository at all. */
let notARepo: string;

describe('git common dir (Issue #1662)', () => {
  beforeAll(() => {
    sandbox = mkdtempSync(path.join(tmpdir(), 'cm-1662-'));

    repoA = initRepository(path.join(sandbox, 'repo-a'));
    repoAWorktree = path.join(sandbox, 'repo-a-develop');
    git(repoA, 'worktree', 'add', '--quiet', '-b', 'develop', repoAWorktree);
    repoAWorktree2 = path.join(sandbox, 'repo-a-feature');
    git(repoA, 'worktree', 'add', '--quiet', '-b', 'feature', repoAWorktree2);

    repoB = initRepository(path.join(sandbox, 'repo-b'));

    notARepo = path.join(sandbox, 'plain-dir');
    mkdirSync(notARepo, { recursive: true });
  });

  afterAll(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  describe('resolveGitCommonDir', () => {
    it('reports the same common dir for a main checkout and its linked worktree', async () => {
      const fromMain = await resolveGitCommonDir(repoA);
      const fromWorktree = await resolveGitCommonDir(repoAWorktree);

      expect(fromMain).not.toBeNull();
      // The reason the comparison works at all: two different directories, one
      // answer. (Also pins the relative-vs-absolute normalization — git prints
      // ".git" for the first and an absolute path for the second.)
      expect(fromWorktree).toBe(fromMain);
      expect(path.isAbsolute(fromMain!)).toBe(true);
      expect(path.basename(fromMain!)).toBe('.git');
    });

    it('reports different common dirs for different repositories', async () => {
      const a = await resolveGitCommonDir(repoA);
      const b = await resolveGitCommonDir(repoB);

      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      expect(a).not.toBe(b);
    });

    it('returns null for a directory that is not a git repository', async () => {
      expect(await resolveGitCommonDir(notARepo)).toBeNull();
    });

    it('returns null for a path that does not exist', async () => {
      expect(await resolveGitCommonDir(path.join(sandbox, 'nope'))).toBeNull();
    });

    it('resolves symlinked spellings of one repository to the same common dir', async () => {
      const linked = path.join(sandbox, 'repo-a-symlink');
      symlinkSync(repoA, linked, 'dir');

      expect(await resolveGitCommonDir(linked)).toBe(await resolveGitCommonDir(repoA));
    });
  });

  describe('resolveGitCommonDirs', () => {
    it('omits paths git cannot answer for, and keeps the ones it can', async () => {
      const resolved = await resolveGitCommonDirs([repoA, notARepo, repoB]);

      expect(resolved.has(repoA)).toBe(true);
      expect(resolved.has(repoB)).toBe(true);
      expect(resolved.has(notARepo)).toBe(false);
    });

    it('keys the result by the caller’s original strings', async () => {
      const trailingSlash = `${repoA}${path.sep}`;
      const resolved = await resolveGitCommonDirs([trailingSlash]);

      expect(resolved.get(trailingSlash)).toBe(await resolveGitCommonDir(repoA));
    });
  });

  describe('findDuplicateScanRoots', () => {
    it('groups the worktrees of one repository together', async () => {
      const groups = await findDuplicateScanRoots([repoA, repoB, repoAWorktree]);

      expect(groups).toHaveLength(1);
      expect([...groups[0].paths].sort()).toEqual([repoA, repoAWorktree].sort());
      expect(groups[0].commonDir).toBe(await resolveGitCommonDir(repoA));
    });

    it('groups three roots of one repository into a single group', async () => {
      const groups = await findDuplicateScanRoots([repoA, repoAWorktree, repoAWorktree2]);

      expect(groups).toHaveLength(1);
      expect(groups[0].paths).toHaveLength(3);
    });

    it('finds nothing when every root is its own repository', async () => {
      // The false-positive guard: two worktrees of two DIFFERENT repositories
      // are the ordinary configuration and must never be flagged.
      const otherWorktree = path.join(sandbox, 'repo-b-develop');
      git(repoB, 'worktree', 'add', '--quiet', '-b', 'develop', otherWorktree);

      expect(await findDuplicateScanRoots([repoA, repoB])).toEqual([]);
      expect(await findDuplicateScanRoots([repoAWorktree, otherWorktree])).toEqual([]);
    });

    it('finds nothing among non-repositories', async () => {
      expect(await findDuplicateScanRoots([notARepo, path.join(sandbox, 'nope')])).toEqual([]);
    });

    it('does not group a single root with itself', async () => {
      expect(await findDuplicateScanRoots([repoA])).toEqual([]);
      expect(await findDuplicateScanRoots([repoA, repoA])).toEqual([]);
    });
  });

  describe('findScanRootsSharingGitRepository', () => {
    it('reports the existing root a sibling worktree would duplicate', async () => {
      expect(await findScanRootsSharingGitRepository(repoAWorktree, [repoA, repoB])).toEqual([
        repoA,
      ]);
    });

    it('reports every existing root of the same repository', async () => {
      const found = await findScanRootsSharingGitRepository(repoAWorktree2, [
        repoA,
        repoAWorktree,
        repoB,
      ]);
      expect([...found].sort()).toEqual([repoA, repoAWorktree].sort());
    });

    it('reports nothing for a genuinely new repository', async () => {
      expect(await findScanRootsSharingGitRepository(repoB, [repoA, repoAWorktree])).toEqual([]);
    });

    it('does not treat re-registering the SAME root as a duplicate', async () => {
      // Otherwise the warning would fire on every ordinary re-scan of a path
      // that is already registered.
      expect(await findScanRootsSharingGitRepository(repoA, [repoA, repoB])).toEqual([]);
    });

    it('recognises a symlinked spelling of an existing root as that root', async () => {
      const linked = path.join(sandbox, 'repo-a-alias');
      symlinkSync(repoA, linked, 'dir');

      expect(await findScanRootsSharingGitRepository(linked, [repoA])).toEqual([]);
    });

    it('reports nothing when the candidate is not a git repository', async () => {
      expect(await findScanRootsSharingGitRepository(notARepo, [repoA])).toEqual([]);
    });

    it('reports nothing when the candidate does not exist', async () => {
      expect(
        await findScanRootsSharingGitRepository(path.join(sandbox, 'nope'), [repoA])
      ).toEqual([]);
    });

    it('ignores existing roots git cannot answer for', async () => {
      expect(await findScanRootsSharingGitRepository(repoAWorktree, [notARepo, repoA])).toEqual([
        repoA,
      ]);
    });
  });
});
