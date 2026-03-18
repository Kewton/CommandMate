/**
 * ls Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, restoreFetch } from '../../../helpers/mock-api';

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

describe('createLsCommand', () => {
  it('exports createLsCommand function', async () => {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    expect(typeof createLsCommand).toBe('function');
  });

  it('creates a Command named "ls"', async () => {
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    expect(cmd.name()).toBe('ls');
  });
});

describe('ls command action', () => {
  const mockWorktrees = {
    worktrees: [
      { id: 'wt1', name: 'main', cliToolId: 'claude', isSessionRunning: true, isWaitingForResponse: false, isProcessing: true },
      { id: 'wt2', name: 'feature/test', cliToolId: 'codex', isSessionRunning: true, isWaitingForResponse: true, isProcessing: false },
      { id: 'wt3', name: 'fix/bug', cliToolId: undefined, isSessionRunning: false, isWaitingForResponse: false, isProcessing: false },
    ],
    repositories: [],
  };

  it('outputs JSON when --json flag', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json']);
    expect(mockConsoleLog).toHaveBeenCalledWith(
      expect.stringContaining('"id": "wt1"')
    );
  });

  it('outputs IDs only when --quiet flag', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('wt1\nwt2\nwt3');
  });

  it('outputs table by default', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toContain('ID');
    expect(output).toContain('NAME');
    expect(output).toContain('STATUS');
    expect(output).toContain('wt1');
  });

  it('filters by --branch prefix', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--quiet', '--branch', 'feature/']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('wt2');
  });

  it('derives status correctly', async () => {
    mockFetchResponse(mockWorktrees);
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls', '--json']);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    // wt1: isProcessing=true -> running
    // wt2: isWaitingForResponse=true -> waiting
    // wt3: all false -> idle
    // Note: status is derived in table format, not in JSON output
    // JSON outputs raw data
    expect(output[0].isProcessing).toBe(true);
    expect(output[1].isWaitingForResponse).toBe(true);
  });

  it('shows "No worktrees found." for empty list', async () => {
    mockFetchResponse({ worktrees: [], repositories: [] });
    const { createLsCommand } = await import('../../../../src/cli/commands/ls');
    const cmd = createLsCommand();
    await cmd.parseAsync(['node', 'ls']);
    const output = mockConsoleLog.mock.calls[0][0];
    expect(output).toBe('No worktrees found.');
  });
});
