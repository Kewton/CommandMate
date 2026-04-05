/**
 * Tests for github-api.ts
 * Issue #630: Issue context in report
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Hoist mock functions
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

// Mock child_process + util
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));
vi.mock('util', () => ({
  promisify: () => mockExecFileAsync,
}));

import { getIssueInfo, collectIssueInfos } from '@/lib/git/github-api';

describe('getIssueInfo (Issue #630)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return IssueInfo when gh CLI succeeds', async () => {
    // First call: gh --version (availability check)
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' });
    // Second call: gh issue view
    const ghOutput = JSON.stringify({
      number: 123,
      title: 'Test Issue',
      body: 'This is the body',
      labels: [{ name: 'bug' }],
      state: 'OPEN',
    });
    mockExecFileAsync.mockResolvedValueOnce({ stdout: ghOutput, stderr: '' });

    const result = await getIssueInfo(123, '/some/repo', 'MyRepo');

    expect(result).not.toBeNull();
    expect(result?.number).toBe(123);
    expect(result?.title).toBe('Test Issue');
    expect(result?.repositoryName).toBe('MyRepo');
    expect(result?.labels).toContain('bug');
    expect(result?.state).toBe('OPEN');
    expect(result?.bodySummary).toBe('This is the body');
  });

  it('should truncate body to MAX_ISSUE_BODY_LENGTH', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' });
    const longBody = 'x'.repeat(1000);
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 1,
        title: 'T',
        body: longBody,
        labels: [],
        state: 'CLOSED',
      }),
      stderr: '',
    });

    const result = await getIssueInfo(1, '/repo', 'Repo');

    expect(result?.bodySummary.length).toBeLessThanOrEqual(500);
  });

  it('should return null when gh CLI is not available', async () => {
    mockExecFileAsync.mockRejectedValueOnce(new Error('command not found: gh'));

    const result = await getIssueInfo(123, '/some/repo', 'MyRepo');

    expect(result).toBeNull();
  });

  it('should return null when gh issue view fails (auth error)', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' });
    mockExecFileAsync.mockRejectedValueOnce(new Error('authentication required'));

    const result = await getIssueInfo(123, '/some/repo', 'MyRepo');

    expect(result).toBeNull();
  });

  it('should return null when issue not found', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' });
    mockExecFileAsync.mockRejectedValueOnce(new Error('Could not resolve to an issue'));

    const result = await getIssueInfo(999, '/some/repo', 'MyRepo');

    expect(result).toBeNull();
  });

  it('should extract label names from label objects', async () => {
    mockExecFileAsync.mockResolvedValueOnce({ stdout: 'gh version 2.0.0', stderr: '' });
    mockExecFileAsync.mockResolvedValueOnce({
      stdout: JSON.stringify({
        number: 1,
        title: 'T',
        body: 'body',
        labels: [{ name: 'bug' }, { name: 'feature' }],
        state: 'OPEN',
      }),
      stderr: '',
    });

    const result = await getIssueInfo(1, '/repo', 'Repo');

    expect(result?.labels).toEqual(['bug', 'feature']);
  });
});

describe('collectIssueInfos (Issue #630)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should collect issue infos for given issue numbers and repositories', async () => {
    const repos = [{ id: 'r1', name: 'MyRepo', path: '/repo1' }];
    const commitMessages = ['fix bug #123'];

    mockExecFileAsync.mockImplementation((_cmd: unknown, args: string[]) => {
      if (args[0] === '--version') {
        return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
      }
      return Promise.resolve({
        stdout: JSON.stringify({
          number: 123,
          title: 'Bug fix',
          body: 'Some body',
          labels: [{ name: 'bug' }],
          state: 'CLOSED',
        }),
        stderr: '',
      });
    });

    const result = await collectIssueInfos(repos, commitMessages);

    expect(Array.isArray(result)).toBe(true);
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].number).toBe(123);
  });

  it('should return empty array when no issue numbers extracted', async () => {
    const repos = [{ id: 'r1', name: 'MyRepo', path: '/repo1' }];
    const commitMessages = ['no issue reference here'];

    const result = await collectIssueInfos(repos, commitMessages);

    expect(result).toEqual([]);
  });

  it('should limit to MAX_ISSUES_PER_REPORT issues', async () => {
    // Create 25 commit messages each with unique issue numbers
    const commitMessages = Array.from({ length: 25 }, (_, i) => `fix #${i + 1}`);
    const repos = [{ id: 'r1', name: 'MyRepo', path: '/repo1' }];

    // Mock all gh calls to succeed
    mockExecFileAsync.mockResolvedValue({
      stdout: JSON.stringify({
        number: 1,
        title: 'T',
        body: 'b',
        labels: [],
        state: 'OPEN',
      }),
      stderr: '',
    });

    const result = await collectIssueInfos(repos, commitMessages);

    expect(result.length).toBeLessThanOrEqual(20);
  });

  it('should gracefully handle partial failures', async () => {
    const repos = [{ id: 'r1', name: 'MyRepo', path: '/repo1' }];
    const commitMessages = ['fix #1 and #2'];

    // Use mockImplementation to handle concurrent calls safely
    // gh --version always succeeds; gh issue view returns based on issue number
    mockExecFileAsync.mockImplementation(
      (_cmd: unknown, args: string[]) => {
        if (args[0] === '--version') {
          return Promise.resolve({ stdout: 'gh version 2.0.0', stderr: '' });
        }
        // args: ['issue', 'view', '<number>', '--json', ...]
        const num = parseInt(args[2] ?? '0', 10);
        if (num === 1) {
          return Promise.resolve({
            stdout: JSON.stringify({ number: 1, title: 'T1', body: 'b1', labels: [], state: 'OPEN' }),
            stderr: '',
          });
        }
        return Promise.reject(new Error('not found'));
      }
    );

    const result = await collectIssueInfos(repos, commitMessages);

    // Should include only the successful one
    expect(result.some(i => i.number === 1)).toBe(true);
    expect(result.some(i => i.number === 2)).toBe(false);
  });
});
