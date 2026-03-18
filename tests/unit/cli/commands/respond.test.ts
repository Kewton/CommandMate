/**
 * respond Command Tests
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

describe('createRespondCommand', () => {
  it('creates a Command named "respond"', async () => {
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    expect(cmd.name()).toBe('respond');
  });
});

describe('respond command action', () => {
  it('sends answer with prompt-response API', async () => {
    mockFetchResponse({ success: true, answer: 'yes' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/prompt-response'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ answer: 'yes' }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Response sent.');
  });

  it('sends with --agent flag as cliTool', async () => {
    mockFetchResponse({ success: true, answer: 'yes' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes', '--agent', 'claude']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        body: JSON.stringify({ answer: 'yes', cliTool: 'claude' }),
      })
    );
  });

  it('handles failure reason from API', async () => {
    mockFetchResponse({ success: false, answer: '', reason: 'prompt_no_longer_active' }, 200);
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);

    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('prompt_no_longer_active')
    );
    expect(mockExit).toHaveBeenCalledWith(99); // UNEXPECTED_ERROR
  });

  it('rejects invalid worktree ID', async () => {
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', '../bad', 'yes']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server connection error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createRespondCommand } = await import('../../../../src/cli/commands/respond');
    const cmd = createRespondCommand();
    await cmd.parseAsync(['node', 'respond', 'wt1', 'yes']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
