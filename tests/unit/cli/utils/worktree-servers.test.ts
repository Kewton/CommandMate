/**
 * Worktree Server Enumeration Tests
 * Issue #1194: listRunningWorktreeServers (D-16 / S3-004)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';

vi.mock('fs');
vi.mock('../../../../src/cli/utils/env-setup', () => ({
  getPidsDir: vi.fn(() => '/mock/home/.commandmate/pids'),
}));
vi.mock('../../../../src/cli/utils/daemon-factory', () => ({
  getDaemonManagerFactory: vi.fn(),
}));

// Import after mocking
import { listRunningWorktreeServers } from '../../../../src/cli/utils/worktree-servers';
import { getPidsDir } from '../../../../src/cli/utils/env-setup';
import { getDaemonManagerFactory } from '../../../../src/cli/utils/daemon-factory';

/**
 * Wire the daemon factory so that only the given issue numbers report running.
 */
function mockFactory(runningIssues: number[]): ReturnType<typeof vi.fn> {
  const create = vi.fn((issueNo?: number) => ({
    start: vi.fn(),
    stop: vi.fn(),
    getStatus: vi.fn(),
    isRunning: vi.fn().mockResolvedValue(
      issueNo !== undefined && runningIssues.includes(issueNo)
    ),
  }));
  vi.mocked(getDaemonManagerFactory).mockReturnValue({
    create,
  } as unknown as ReturnType<typeof getDaemonManagerFactory>);
  return create;
}

describe('listRunningWorktreeServers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getPidsDir).mockReturnValue('/mock/home/.commandmate/pids');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should return only issue numbers whose server is running', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '135.pid',
      '200.pid',
      '300.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFactory([135, 300]);

    const result = await listRunningWorktreeServers();

    expect(result).toEqual([135, 300]);
  });

  it('should read from getPidsDir()', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFactory([]);

    await listRunningWorktreeServers();

    expect(getPidsDir).toHaveBeenCalled();
    expect(fs.readdirSync).toHaveBeenCalledWith('/mock/home/.commandmate/pids');
  });

  it('should create a daemon manager per issue number', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '135.pid',
      '200.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const create = mockFactory([135]);

    await listRunningWorktreeServers();

    expect(create).toHaveBeenCalledWith(135);
    expect(create).toHaveBeenCalledWith(200);
  });

  it('should ignore non-pid files', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '135.pid',
      'README.md',
      '.DS_Store',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const create = mockFactory([135]);

    const result = await listRunningWorktreeServers();

    expect(result).toEqual([135]);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it('should ignore pid files with a non-numeric name', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      'main.pid',
      '135.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const create = mockFactory([135]);

    const result = await listRunningWorktreeServers();

    expect(result).toEqual([135]);
    expect(create).not.toHaveBeenCalledWith(NaN);
  });

  it('should return an empty array when no server is running', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '135.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFactory([]);

    await expect(listRunningWorktreeServers()).resolves.toEqual([]);
  });

  it('should return an empty array when the pids directory does not exist', async () => {
    vi.mocked(fs.readdirSync).mockImplementation(() => {
      const error = new Error('ENOENT') as NodeJS.ErrnoException;
      error.code = 'ENOENT';
      throw error;
    });
    mockFactory([]);

    await expect(listRunningWorktreeServers()).resolves.toEqual([]);
  });

  it('should return results sorted ascending', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '300.pid',
      '20.pid',
      '135.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    mockFactory([300, 20, 135]);

    await expect(listRunningWorktreeServers()).resolves.toEqual([20, 135, 300]);
  });

  it('should skip an issue whose liveness check throws', async () => {
    vi.mocked(fs.readdirSync).mockReturnValue([
      '135.pid',
      '200.pid',
    ] as unknown as ReturnType<typeof fs.readdirSync>);
    const create = vi.fn((issueNo?: number) => ({
      start: vi.fn(),
      stop: vi.fn(),
      getStatus: vi.fn(),
      isRunning:
        issueNo === 135
          ? vi.fn().mockRejectedValue(new Error('boom'))
          : vi.fn().mockResolvedValue(true),
    }));
    vi.mocked(getDaemonManagerFactory).mockReturnValue({
      create,
    } as unknown as ReturnType<typeof getDaemonManagerFactory>);

    await expect(listRunningWorktreeServers()).resolves.toEqual([200]);
  });
});
