/**
 * send Command Tests
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

describe('createSendCommand', () => {
  it('creates a Command named "send"', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    expect(cmd.name()).toBe('send');
  });
});

describe('send command action', () => {
  it('sends message with content key', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'hello', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello world']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ content: 'hello world' }),
      })
    );
    expect(mockConsoleError).toHaveBeenCalledWith('Message sent.');
  });

  it('sends with --agent flag (cliToolId)', async () => {
    mockFetchResponse({ id: 1, role: 'user', content: 'test', worktreeId: 'wt1' }, 201);
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--agent', 'codex']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('/api/worktrees/wt1/send'),
      expect.objectContaining({
        body: JSON.stringify({ content: 'test', cliToolId: 'codex' }),
      })
    );
  });

  it('enables auto-yes before sending when --auto-yes', async () => {
    // Two API calls: auto-yes then send
    const mockFn = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.resolve({}), text: () => Promise.resolve('{}') })
      .mockResolvedValueOnce({ ok: true, status: 201, json: () => Promise.resolve({ id: 1 }), text: () => Promise.resolve('{"id":1}') });
    global.fetch = mockFn;

    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'test', '--auto-yes']);

    expect(mockFn).toHaveBeenCalledTimes(2);
    // First call: auto-yes
    expect(mockFn.mock.calls[0][0]).toContain('/auto-yes');
    // Second call: send
    expect(mockFn.mock.calls[1][0]).toContain('/send');
  });

  it('rejects invalid agent with CLI_TOOL_IDS list', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--agent', 'invalid-agent']);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('claude')
    );
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('codex')
    );
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects invalid worktree ID', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', '../invalid', 'hello']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });

  it('rejects stop-pattern exceeding max length', async () => {
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    const longPattern = 'x'.repeat(501);
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello', '--auto-yes', '--stop-pattern', longPattern]);
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('stop-pattern exceeds maximum length')
    );
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createSendCommand } = await import('../../../../src/cli/commands/send');
    const cmd = createSendCommand();
    await cmd.parseAsync(['node', 'send', 'wt1', 'hello']);
    expect(mockExit).toHaveBeenCalledWith(1); // DEPENDENCY_ERROR
  });
});
