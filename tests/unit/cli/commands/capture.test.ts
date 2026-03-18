/**
 * capture Command Tests
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

const sampleOutput = {
  isRunning: true,
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: true,
  content: 'Hello from agent',
  fullOutput: 'Full output with lots of text',
  realtimeSnippet: 'snippet...',
  lineCount: 10,
  lastCapturedLine: 10,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: '',
  thinkingMessage: null,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: true,
};

describe('createCaptureCommand', () => {
  it('creates a Command named "capture"', async () => {
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    expect(cmd.name()).toBe('capture');
  });
});

describe('capture command action', () => {
  it('outputs plain text (content) by default', async () => {
    mockFetchResponse(sampleOutput);
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    await cmd.parseAsync(['node', 'capture', 'wt1']);
    expect(mockConsoleLog).toHaveBeenCalledWith('Hello from agent');
  });

  it('outputs JSON without fullOutput when --json', async () => {
    mockFetchResponse(sampleOutput);
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    await cmd.parseAsync(['node', 'capture', 'wt1', '--json']);

    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.content).toBe('Hello from agent');
    // fullOutput should be excluded
    expect(output.fullOutput).toBeUndefined();
    expect(output.isRunning).toBe(true);
  });

  it('passes --agent as cliTool query param', async () => {
    mockFetchResponse(sampleOutput);
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    await cmd.parseAsync(['node', 'capture', 'wt1', '--agent', 'codex']);

    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('cliTool=codex'),
      expect.any(Object)
    );
  });

  it('rejects invalid worktree ID', async () => {
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    await cmd.parseAsync(['node', 'capture', '../bad']);
    expect(mockExit).toHaveBeenCalledWith(2);
  });

  it('handles server error', async () => {
    mockFetchError('connect ECONNREFUSED 127.0.0.1:3000');
    const { createCaptureCommand } = await import('../../../../src/cli/commands/capture');
    const cmd = createCaptureCommand();
    await cmd.parseAsync(['node', 'capture', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(1);
  });
});
