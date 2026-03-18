/**
 * auto-yes Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchResponse, mockFetchError, restoreFetch } from '../../../helpers/mock-api';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

describe('createAutoYesCommand', () => {
  it('creates a Command named "auto-yes"', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    expect(cmd.name()).toBe('auto-yes');
  });
});

describe('auto-yes command action', () => {
  it('enables auto-yes with default duration', async () => {
    mockFetchResponse({}, 200);
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/auto-yes'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ enabled: true, duration: 3600000 }), // 1h default
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Auto-yes enabled for wt1.');
  });

  it('enables with custom duration', async () => {
    mockFetchResponse({}, 200);
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--duration', '3h']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ enabled: true, duration: 10800000 }), // 3h
      })
    );
  });

  it('enables with --agent', async () => {
    mockFetchResponse({}, 200);
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--agent', 'codex']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ enabled: true, duration: 3600000, cliToolId: 'codex' }),
      })
    );
  });

  it('enables with --stop-pattern', async () => {
    mockFetchResponse({}, 200);
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--stop-pattern', 'error.*']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ enabled: true, duration: 3600000, stopPattern: 'error.*' }),
      })
    );
  });

  it('disables auto-yes', async () => {
    mockFetchResponse({}, 200);
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--disable']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ enabled: false }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Auto-yes disabled for wt1.');
  });

  it('requires --enable or --disable', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1']);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Specify --enable or --disable.');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects both --enable and --disable', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--disable']);
    expect(mockConsoleError).toHaveBeenCalledWith('Error: Cannot specify both --enable and --disable.');
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects invalid worktree ID', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', '../bad', '--enable']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects invalid duration', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--duration', '99h']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Invalid duration')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('rejects stop-pattern exceeding max length', async () => {
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    const longPattern = 'x'.repeat(501);
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable', '--stop-pattern', longPattern]);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('stop-pattern exceeds maximum length')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createAutoYesCommand } = await import('../../../../src/cli/commands/auto-yes');
    const cmd = createAutoYesCommand();
    await cmd.parseAsync(['node', 'auto-yes', 'wt1', '--enable']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
