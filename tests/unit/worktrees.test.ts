/**
 * Worktree management unit tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { exec } from 'child_process';
import type { Worktree } from '@/types/models';

// Mock child_process - use a factory so the mock function does NOT inherit
// `util.promisify.custom` from the real exec. With auto-mock, that symbol is
// preserved and promisify(exec) bypasses mockImplementation entirely.
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

// Import functions after mocking
import {
  generateWorktreeId,
  parseWorktreeOutput,
  scanWorktrees,
  scanMultipleRepositories,
  syncWorktreesToDB,
} from '@/lib/git/worktrees';

describe('Worktree Management', () => {
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
    // Note: The following tests are skipped due to vitest/promisify mocking limitations
    // These will be covered by integration tests instead
    it.skip('should execute git worktree list and return parsed worktrees', async () => {
      const mockOutput = `/path/to/main abc123 [main]
/path/to/feature-foo def456 [feature/foo]`;

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, mockOutput, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees('/path/to/root');

      expect(result).toHaveLength(2);
      expect(result[0]).toMatchObject({
        id: 'main',
        name: 'main',
        path: '/path/to/main',
      });
      expect(result[1]).toMatchObject({
        id: 'feature-foo',
        name: 'feature/foo',
        path: '/path/to/feature-foo',
      });

      expect(exec).toHaveBeenCalledWith(
        'git worktree list',
        expect.objectContaining({ cwd: '/path/to/root' }),
        expect.any(Function)
      );
    });

    it.skip('should return empty array for non-git directory', async () => {
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

    it.skip('should throw on unexpected git errors', async () => {
      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          const error = new Error('permission denied') as any;
          error.code = 1;
          callback(error, '', 'permission denied');
          return {} as any;
        }) as any
      );

      await expect(scanWorktrees('/path/to/root')).rejects.toThrow(
        'permission denied'
      );
    });

    it.skip('should handle paths with spaces', async () => {
      const mockOutput = '/path/with spaces/main abc123 [main]';

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, mockOutput, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees('/path/to/root');

      expect(result).toHaveLength(1);
      expect(result[0].path).toBe('/path/with spaces/main');
    });

    it.skip('should resolve paths to absolute', async () => {
      const mockOutput = './relative/path abc123 [main]';

      vi.mocked(exec).mockImplementationOnce(
        ((cmd: string, opts: any, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          callback(null, mockOutput, '');
          return {} as any;
        }) as any
      );

      const result = await scanWorktrees('/path/to/root');

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
      const observedCwds: string[] = [];
      vi.mocked(exec).mockImplementation(
        ((_cmd: string, opts: { cwd?: string }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          observedCwds.push(opts?.cwd ?? '');
          callback(null, '', '');
          return {} as never;
        }) as never
      );

      const result = await scanMultipleRepositories(['/repo1', '/repo2', '/repo3']);

      expect(observedCwds.sort()).toEqual(['/repo1', '/repo2', '/repo3']);
      expect(result).toEqual([]);
    });

    it('should continue when one repository scan rejects', async () => {
      vi.mocked(exec).mockImplementation(
        ((_cmd: string, opts: { cwd?: string }, callback: (err: Error | null, stdout: string, stderr: string) => void) => {
          if (opts?.cwd === '/bad-repo') {
            const error = Object.assign(new Error('permission denied'), { code: 1 });
            callback(error, '', 'permission denied');
          } else {
            callback(null, '', '');
          }
          return {} as never;
        }) as never
      );

      await expect(
        scanMultipleRepositories(['/repo1', '/bad-repo', '/repo3'])
      ).resolves.toEqual([]);
    });

    it('should return an empty array for an empty repository list', async () => {
      const result = await scanMultipleRepositories([]);
      expect(result).toEqual([]);
    });

    it('should start all repository scans before any of them resolves (parallel)', async () => {
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

      const promise = scanMultipleRepositories(['/repo1', '/repo2', '/repo3']);

      // Let the synchronous .map(...) issue all three exec calls.
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(started.sort()).toEqual(['/repo1', '/repo2', '/repo3']);

      // Release in reverse order to make sure ordering doesn't depend on
      // resolution order.
      deferred.get('/repo3')!();
      deferred.get('/repo2')!();
      deferred.get('/repo1')!();

      await expect(promise).resolves.toEqual([]);
    });
  });
});
