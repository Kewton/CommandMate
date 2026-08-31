/**
 * Worktree management unit tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest';
import { exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import type { Worktree } from '@/types/models';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

// Mock child_process - use a factory so the mock function does NOT inherit
// `util.promisify.custom` from the real exec. With auto-mock, that symbol is
// preserved and promisify(exec) bypasses mockImplementation entirely.
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Import functions after mocking
import {
  generateWorktreeId,
  getRepositoryPaths,
  parseWorktreeOutput,
  scanWorktrees,
  scanMultipleRepositories,
  syncWorktreesToDB,
} from '@/lib/git/worktrees';

describe('Worktree Management', () => {
  // Issue #2165: `scanWorktrees` now refuses to spawn into a directory it can
  // confirm is absent, so every scan test needs a root that really exists. The
  // sandbox is read-only fixture material — one per file, not one per test.
  let sandbox: string;
  /** An existing directory to hand `scanWorktrees` as its scan root. */
  let repoRoot: string;

  beforeAll(() => {
    sandbox = makeTempDir('worktrees-scan-');
    repoRoot = path.join(sandbox, 'root');
    fs.mkdirSync(repoRoot, { recursive: true });
  });

  afterAll(() => {
    removeTempDir(sandbox);
  });

  /** Create (once) and return an existing directory under the sandbox. */
  function repoDir(name: string): string {
    const dir = path.join(sandbox, name);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    // Set up default implementation that works with promisify
    vi.mocked(exec).mockImplementation(
      ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
        if (callback) callback(null, '', '');
        return {} as any;
      }) as any
    );
  });

  describe('generateWorktreeId', () => {
    it('should convert branch name with slashes to hyphen-separated ID', () => {
      expect(generateWorktreeId('feature/foo')).toBe('feature-foo');
    });

    it('should handle main branch', () => {
      expect(generateWorktreeId('main')).toBe('main');
    });

    it('should handle complex branch names', () => {
      expect(generateWorktreeId('feature/user-auth/v2')).toBe(
        'feature-user-auth-v2'
      );
    });

    it('should convert to lowercase', () => {
      expect(generateWorktreeId('Feature/Foo')).toBe('feature-foo');
    });

    it('should handle special characters', () => {
      expect(generateWorktreeId('feature/foo@bar')).toBe('feature-foo-bar');
      expect(generateWorktreeId('feature/foo#123')).toBe('feature-foo-123');
    });

    it('should handle consecutive special characters', () => {
      expect(generateWorktreeId('feature//foo')).toBe('feature-foo');
      expect(generateWorktreeId('feature/@/foo')).toBe('feature-foo');
    });

    it('should handle empty string', () => {
      expect(generateWorktreeId('')).toBe('');
    });

    it('should handle branch name with dots', () => {
      expect(generateWorktreeId('release/v1.0.0')).toBe('release-v1-0-0');
    });

    it('should include repository name in ID when provided', () => {
      expect(generateWorktreeId('main', 'MyRepo')).toBe('myrepo-main');
      expect(generateWorktreeId('feature/foo', 'MyRepo')).toBe('myrepo-feature-foo');
    });

    it('should handle repository name with special characters', () => {
      expect(generateWorktreeId('main', 'My-Repo')).toBe('my-repo-main');
      expect(generateWorktreeId('main', 'MyRepo.js')).toBe('myrepo-js-main');
    });

    it('should create unique IDs for same branch in different repos', () => {
      const id1 = generateWorktreeId('main', 'RepoA');
      const id2 = generateWorktreeId('main', 'RepoB');
      expect(id1).not.toBe(id2);
      expect(id1).toBe('repoa-main');
      expect(id2).toBe('repob-main');
    });
  });

  describe('parseWorktreeOutput', () => {
    it('should parse standard git worktree list output', () => {
      const output = '/path/to/main  abc123 [main]';
      const result = parseWorktreeOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        path: '/path/to/main',
        branch: 'main',
        commit: 'abc123',
      });
    });

    it('should parse multiple worktrees', () => {
      const output = `/path/to/main        abc123 [main]
/path/to/feature-foo def456 [feature/foo]
/path/to/hotfix-bar  ghi789 [hotfix/bar]`;

      const result = parseWorktreeOutput(output);

      expect(result).toHaveLength(3);
      expect(result[0]).toEqual({
        path: '/path/to/main',
        branch: 'main',
        commit: 'abc123',
      });
      expect(result[1]).toEqual({
        path: '/path/to/feature-foo',
        branch: 'feature/foo',
        commit: 'def456',
      });
      expect(result[2]).toEqual({
        path: '/path/to/hotfix-bar',
        branch: 'hotfix/bar',
        commit: 'ghi789',
      });
    });

    it('should handle detached HEAD', () => {
      const output = '/path/to/detached abc123 (detached HEAD)';
      const result = parseWorktreeOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].branch).toBe('detached-abc123');
      expect(result[0].commit).toBe('abc123');
    });

    it('should handle empty output', () => {
      expect(parseWorktreeOutput('')).toEqual([]);
    });

    it('should handle output with extra whitespace', () => {
      const output = '  /path/to/main    abc123   [main]  ';
      const result = parseWorktreeOutput(output);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/path/to/main');
    });

    it('should skip invalid lines', () => {
      const output = `
/path/to/main abc123 [main]
invalid line
/path/to/feature def456 [feature/foo]
      `.trim();

      const result = parseWorktreeOutput(output);

      expect(result).toHaveLength(2);
      expect(result[0].path).toBe('/path/to/main');
      expect(result[1].path).toBe('/path/to/feature');
    });
  });

  describe('scanWorktrees', () => {
    // Issue #764: Revived previously-skipped tests. The factory mock for
    // child_process strips `util.promisify.custom`, so `promisify(exec)` uses
    // standard promisification and resolves with the FIRST callback value.
    // The mock must therefore pass `{ stdout, stderr }` as that value so
    // `const { stdout } = await execAsync(...)` in scanWorktrees works.
    it('should execute git worktree list and return parsed worktrees', async () => {
      const mockOutput = `/path/to/main abc123 [main]
/path/to/feature-foo def456 [feature/foo]`;

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, { stdout: mockOutput, stderr: '' } as any, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees(repoRoot);

      expect(result).toHaveLength(2);
      // Issue #1621: the provisional ID comes from the worktree DIRECTORY, not
      // from the branch and not from the repository name. `name` still carries
      // the branch, so the two are now visibly independent.
      expect(result[0]).toMatchObject({
        id: 'main',
        name: 'main',
        branch: 'main',
        path: '/path/to/main',
      });
      expect(result[1]).toMatchObject({
        id: 'feature-foo',
        name: 'feature/foo',
        branch: 'feature/foo',
        path: '/path/to/feature-foo',
      });

      expect(exec).toHaveBeenCalledWith(
        'git worktree list',
        expect.objectContaining({ cwd: repoRoot }),
        expect.any(Function)
      );
    });

    // Issue #2165: a repository whose directory has been deleted used to reach
    // `exec` with a non-existent cwd, which Node reports as
    // `spawn /bin/sh ENOENT` — an error about the shell, not about the missing
    // directory — and `scanMultipleRepositories` logged it at ERROR forever.
    it('should skip the scan without spawning when the directory is gone', async () => {
      const gone = path.join(sandbox, 'never-existed');

      const result = await scanWorktrees(gone);

      expect(result).toEqual([]);
      expect(exec).not.toHaveBeenCalled();
    });

    it('should still scan a directory that exists but is not a git repository', async () => {
      // The guard above must not swallow the de-gitified case: that directory
      // is present, so git still runs and its exit 128 is what returns [].
      const notARepo = repoDir('not-a-repo');
      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const error = new Error('not a git repository') as any;
          error.code = 128;
          callback(error, '', 'fatal: not a git repository');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees(notARepo);

      expect(result).toEqual([]);
      expect(exec).toHaveBeenCalledWith(
        'git worktree list',
        expect.objectContaining({ cwd: notARepo }),
        expect.any(Function)
      );
    });

    it('should return empty array for non-git directory', async () => {
      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const error = new Error('not a git repository') as any;
          error.code = 128;
          callback(error, '', 'fatal: not a git repository');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees('/tmp');

      expect(result).toEqual([]);
    });

    it('should throw on unexpected git errors', async () => {
      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const error = new Error('permission denied') as any;
          error.code = 1;
          callback(error, '', 'permission denied');
          return {} as any;
        }) as any
      );

      await expect(scanWorktrees(repoRoot)).rejects.toThrow(
        'permission denied'
      );
    });

    it('should handle paths with spaces', async () => {
      const mockOutput = '/path/with spaces/main abc123 [main]';

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, { stdout: mockOutput, stderr: '' } as any, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees(repoRoot);

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/path/with spaces/main');
    });

    it('should resolve paths to absolute', async () => {
      const mockOutput = './relative/path abc123 [main]';

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, { stdout: mockOutput, stderr: '' } as any, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees(repoRoot);

      expect(result).toHaveLength(1);
      // Should be absolute path
      expect(result[0].path).toMatch(/^\//);
    });
  });

  describe('syncWorktreesToDB', () => {
    it('should insert new worktrees to database', async () => {
      // This will be tested with actual database in integration tests
      // Unit test just verifies the function exists and has correct signature
      expect(syncWorktreesToDB).toBeDefined();
      expect(typeof syncWorktreesToDB).toBe('function');
    });
  });

  // Issue #711: scanMultipleRepositories must run repository scans in parallel
  describe('scanMultipleRepositories', () => {
    it('should invoke git worktree list once per repository', async () => {
      const repos = ['repo1', 'repo2', 'repo3'].map(repoDir);
      const observedCwds: string[] = [];
      vi.mocked(exec).mockImplementation(
        ((_cmd: string, opts: { cwd?: string }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          observedCwds.push(opts?.cwd ?? '');
          callback(null, '', '');
          return {} as never;
        }) as never
      );

      const result = await scanMultipleRepositories(repos);

      expect(observedCwds.sort()).toEqual([...repos].sort());
      expect(result).toEqual([]);
    });

    it('should continue when one repository scan rejects', async () => {
      const good1 = repoDir('repo1');
      const bad = repoDir('bad-repo');
      const good2 = repoDir('repo3');
      vi.mocked(exec).mockImplementation(
        ((_cmd: string, opts: { cwd?: string }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          if (opts?.cwd === bad) {
            const error = Object.assign(new Error('permission denied'), { code: 1 });
            callback(error, '', 'permission denied');
          } else {
            callback(null, '', '');
          }
          return {} as never;
        }) as never
      );

      await expect(
        scanMultipleRepositories([good1, bad, good2])
      ).resolves.toEqual([]);
    });

    it('should return an empty array for an empty repository list', async () => {
      const result = await scanMultipleRepositories([]);
      expect(result).toEqual([]);
    });

    it('should start all repository scans before any of them resolves (parallel)', async () => {
      const repos = ['repo1', 'repo2', 'repo3'].map(repoDir);
      const started: string[] = [];
      const deferred = new Map<string, () => void>();

      vi.mocked(exec).mockImplementation(
        ((_cmd: string, opts: { cwd?: string }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const cwd = opts?.cwd ?? '';
          started.push(cwd);
          // Hold the callback until we explicitly release it. With sequential
          // execution, only the first exec would fire and the loop would block
          // waiting for it to resolve; with parallel execution, all three
          // should be observed in `started` before any callback resolves.
          deferred.set(cwd, () => callback(null, '', ''));
          return {} as never;
        }) as never
      );

      const promise = scanMultipleRepositories(repos);

      // Let the synchronous .map(...) issue all three exec calls.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(started.sort()).toEqual([...repos].sort());

      // Release in reverse order to make sure ordering doesn't depend on
      // resolution order.
      deferred.get(repos[2])!();
      deferred.get(repos[1])!();
      deferred.get(repos[0])!();

      await expect(promise).resolves.toEqual([]);
    });
  });

  describe('getRepositoryPaths', () => {
    // Issue #1328: CM_ROOT_DIR is the managed scope (a directory that contains
    // repositories), not a repository. It must never reach `git worktree list`
    // as a cwd.
    const ENV_KEYS = ['WORKTREE_REPOS', 'CM_ROOT_DIR', 'MCBD_ROOT_DIR'] as const;
    const saved: Record<string, string | undefined> = {};

    beforeEach(() => {
      for (const key of ENV_KEYS) {
        saved[key] = process.env[key];
        delete process.env[key];
      }
    });

    afterEach(() => {
      for (const key of ENV_KEYS) {
        if (saved[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = saved[key];
        }
      }
    });

    it('should return the repositories listed in WORKTREE_REPOS', () => {
      process.env.WORKTREE_REPOS = '/path/to/repo1,/path/to/repo2';

      expect(getRepositoryPaths()).toEqual(['/path/to/repo1', '/path/to/repo2']);
    });

    it('should trim whitespace and drop empty WORKTREE_REPOS entries', () => {
      process.env.WORKTREE_REPOS = ' /path/to/repo1 , ,/path/to/repo2,';

      expect(getRepositoryPaths()).toEqual(['/path/to/repo1', '/path/to/repo2']);
    });

    it('should return an empty array when no repository env var is set', () => {
      expect(getRepositoryPaths()).toEqual([]);
    });

    it('should not derive any repository path from CM_ROOT_DIR', () => {
      // CM_ROOT_DIR points at a container of repositories. Scanning it directly
      // yields nothing, so it must contribute no paths at all.
      process.env.CM_ROOT_DIR = '/path/to/container';

      expect(getRepositoryPaths()).toEqual([]);
    });

    it('should not derive any repository path from the deprecated MCBD_ROOT_DIR', () => {
      process.env.MCBD_ROOT_DIR = '/path/to/container';

      expect(getRepositoryPaths()).toEqual([]);
    });

    it('should ignore CM_ROOT_DIR even when WORKTREE_REPOS is also set', () => {
      process.env.CM_ROOT_DIR = '/path/to/container';
      process.env.WORKTREE_REPOS = '/path/to/repo1';

      expect(getRepositoryPaths()).toEqual(['/path/to/repo1']);
    });

    it('should return an empty array when WORKTREE_REPOS is blank, regardless of CM_ROOT_DIR', () => {
      process.env.WORKTREE_REPOS = '   ';
      process.env.CM_ROOT_DIR = '/path/to/container';

      expect(getRepositoryPaths()).toEqual([]);
    });
  });
});
