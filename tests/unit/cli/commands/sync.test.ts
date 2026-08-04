/**
 * sync Command Tests
 * Issue #1680: CLI trigger for the server-side worktree re-scan
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode } from '../../../../src/cli/types';

// Mock process.exit to prevent actual exit
const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const mockSyncResponse = {
  success: true,
  message: 'Successfully synced 5 worktree(s) from 2 repository/repositories',
  worktreeCount: 5,
  repositoryCount: 2,
  repositories: ['/repos/anvil', '/repos/commandmate'],
  deletedCount: 0,
  cleanupWarnings: [],
};

describe('createSyncCommand', () => {
  it('exports createSyncCommand function', async () => {
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    expect(typeof createSyncCommand).toBe('function');
  });

  it('creates a Command named "sync"', async () => {
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    expect(cmd.name()).toBe('sync');
  });
});

describe('sync command action', () => {
  it('POSTs to /api/repositories/sync', async () => {
    mockFetchResponse(mockSyncResponse);
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);

    const fetchMock = global.fetch as ReturnType<typeof vi.fn>;
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toContain('/api/repositories/sync');
    expect((init as RequestInit).method).toBe('POST');
    expect(mockExit).not.toHaveBeenCalled();
  });

  it('prints the server message by default', async () => {
    mockFetchResponse(mockSyncResponse);
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      'Successfully synced 5 worktree(s) from 2 repository/repositories'
    );
  });

  it('mentions removed stale worktrees when deletedCount > 0', async () => {
    mockFetchResponse({ ...mockSyncResponse, deletedCount: 2 });
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleLog).toHaveBeenCalledWith('Removed 2 stale worktree(s).');
  });

  it('does not mention removals when deletedCount is 0', async () => {
    mockFetchResponse(mockSyncResponse);
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    const logged = mockConsoleLog.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).not.toContain('Removed');
  });

  it('prints cleanup warnings to stderr', async () => {
    mockFetchResponse({
      ...mockSyncResponse,
      deletedCount: 1,
      cleanupWarnings: ['1 session cleanup warning(s) occurred'],
    });
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Warning: 1 session cleanup warning(s) occurred'
    );
  });

  it('outputs the API response as JSON when --json flag', async () => {
    mockFetchResponse({ ...mockSyncResponse, deletedCount: 3 });
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync', '--json']);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output).toEqual({ ...mockSyncResponse, deletedCount: 3 });
  });

  it('exits with DEPENDENCY_ERROR and a hint when the server is not running', async () => {
    mockFetchError('fetch failed');
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: Server is not running. Start it with: commandmate start'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.DEPENDENCY_ERROR);
  });

  it('passes the server wording through on 400 (no repositories configured)', async () => {
    mockFetchResponse(
      { error: 'No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR environment variable.' },
      400
    );
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      'Error: No repositories configured. Please set WORKTREE_REPOS or CM_ROOT_DIR environment variable.'
    );
    expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
  });

  it('surfaces the server reason on 500', async () => {
    mockFetchResponse({ error: 'scan blew up' }, 500);
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    await cmd.parseAsync(['node', 'sync']);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Server error: scan blew up');
    expect(mockExit).toHaveBeenCalledWith(ExitCode.UNEXPECTED_ERROR);
  });

  it('registers --json and --token in --help output', async () => {
    const { createSyncCommand } = await import('../../../../src/cli/commands/sync');
    const cmd = createSyncCommand();
    const help = cmd.helpInformation();
    expect(help).toContain('--json');
    expect(help).toContain('--token <token>');
  });
});
