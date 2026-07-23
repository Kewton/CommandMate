/**
 * Tests for fork-manager.ts
 * Issue #1480: Native "fork and add" support for repository registration.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock function
const { mockExecFileAsync } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
}));

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock child_process + util so execFileAsync routes to our mock
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import {
  parseGitHubRepoUrl,
  forkRepository,
  ForkError,
} from '@/lib/git/fork-manager';

/** Queue the three gh calls of a successful fork: version, api user, fork. */
function mockForkSuccess(login: string): void {
  mockExecFileAsync
    .mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' }) // gh --version
    .mockResolvedValueOnce({ stdout: `${login}\n`, stderr: '' }) // gh api user --jq .login
    .mockResolvedValueOnce({ stdout: '', stderr: '' }); // gh repo fork
}

describe('parseGitHubRepoUrl', () => {
  it('parses an HTTPS URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/octocat/hello-world')).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'hello-world',
      scheme: 'https',
    });
  });

  it('parses an HTTPS URL with .git suffix', () => {
    expect(parseGitHubRepoUrl('https://github.com/octocat/hello-world.git')).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'hello-world',
      scheme: 'https',
    });
  });

  it('parses an scp-like SSH URL', () => {
    expect(parseGitHubRepoUrl('git@github.com:octocat/hello-world.git')).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'hello-world',
      scheme: 'ssh-scp',
    });
  });

  it('parses an ssh:// URL', () => {
    expect(parseGitHubRepoUrl('ssh://git@github.com/octocat/hello-world.git')).toEqual({
      host: 'github.com',
      owner: 'octocat',
      repo: 'hello-world',
      scheme: 'ssh-url',
    });
  });

  it('returns null for a non-repo URL', () => {
    expect(parseGitHubRepoUrl('https://github.com/octocat')).toBeNull();
    expect(parseGitHubRepoUrl('not-a-url')).toBeNull();
    expect(parseGitHubRepoUrl('')).toBeNull();
  });

  it('rejects owner/repo containing unsafe characters', () => {
    expect(parseGitHubRepoUrl('https://github.com/oc$tocat/hello')).toBeNull();
    expect(parseGitHubRepoUrl('https://github.com/octocat/hel;lo')).toBeNull();
  });
});

describe('forkRepository', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('throws INVALID_SOURCE_URL without invoking gh for a bad URL', async () => {
    await expect(forkRepository('not-a-github-url')).rejects.toMatchObject({
      code: 'INVALID_SOURCE_URL',
    });
    expect(mockExecFileAsync).not.toHaveBeenCalled();
  });

  it('throws GH_NOT_AVAILABLE when gh is not installed', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('command not found: gh'));
    await expect(
      forkRepository('https://github.com/octocat/hello-world')
    ).rejects.toMatchObject({ code: 'GH_NOT_AVAILABLE' });
  });

  it('throws GH_NOT_AUTHENTICATED when gh api user fails', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' }) // gh --version
      .mockRejectedValueOnce(new Error('gh auth: not logged in')); // gh api user
    await expect(
      forkRepository('https://github.com/octocat/hello-world')
    ).rejects.toMatchObject({ code: 'GH_NOT_AUTHENTICATED' });
  });

  it('throws FORK_FAILED when gh repo fork fails', async () => {
    mockExecFileAsync
      .mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' })
      .mockResolvedValueOnce({ stdout: 'me\n', stderr: '' })
      .mockRejectedValueOnce(
        Object.assign(new Error('fork failed'), { stderr: 'HTTP 403: forbidden' })
      );
    await expect(
      forkRepository('https://github.com/octocat/hello-world')
    ).rejects.toMatchObject({ code: 'FORK_FAILED' });
  });

  it('returns the fork URL and upstream for an HTTPS source', async () => {
    mockForkSuccess('myuser');
    const result = await forkRepository('https://github.com/octocat/hello-world');
    expect(result).toEqual({
      forkUrl: 'https://github.com/myuser/hello-world.git',
      upstreamUrl: 'https://github.com/octocat/hello-world',
      forkFullName: 'myuser/hello-world',
    });
    // Third call is `gh repo fork owner/repo --clone=false`
    const forkCall = mockExecFileAsync.mock.calls[2];
    expect(forkCall[0]).toBe('gh');
    expect(forkCall[1]).toEqual(['repo', 'fork', 'octocat/hello-world', '--clone=false']);
  });

  it('preserves the scp-like SSH scheme in the fork URL', async () => {
    mockForkSuccess('myuser');
    const result = await forkRepository('git@github.com:octocat/hello-world.git');
    expect(result.forkUrl).toBe('git@github.com:myuser/hello-world.git');
  });

  it('preserves the ssh:// scheme in the fork URL', async () => {
    mockForkSuccess('myuser');
    const result = await forkRepository('ssh://git@github.com/octocat/hello-world.git');
    expect(result.forkUrl).toBe('ssh://git@github.com/myuser/hello-world.git');
  });

  it('exposes a ForkError instance', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('no gh'));
    await forkRepository('https://github.com/octocat/hello-world').catch((e) => {
      expect(e).toBeInstanceOf(ForkError);
    });
  });
});
