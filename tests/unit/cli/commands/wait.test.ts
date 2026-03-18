/**
 * wait Command Tests
 * Issue #518
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
});

const baseOutput = {
  isRunning: false,
  isComplete: true,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'done',
  fullOutput: 'done',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: '',
  thinkingMessage: null,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
};

describe('createWaitCommand', () => {
  it('creates a Command named "wait"', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    expect(cmd.name()).toBe('wait');
  });
});

describe('wait command action', () => {
  it('exits 0 on completion (isRunning=false, isPromptWaiting=false)', async () => {
    mockFetchSequence([{ data: baseOutput }]);
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('exits 10 on prompt detection with JSON output', async () => {
    const promptOutput = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      promptData: { type: 'yes_no', question: 'Continue?', options: ['yes', 'no'], status: 'pending' },
    };
    mockFetchSequence([{ data: promptOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    // Check JSON output on stdout
    expect(mockConsoleLog).toHaveBeenCalled();
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.worktreeId).toBe('wt1');
    expect(output.type).toBe('yes_no');
    expect(output.question).toBe('Continue?');
  });

  it('rejects invalid worktree ID', async () => {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', '../bad-id']);
    expect(mockExit).toHaveBeenCalledWith(2); // CONFIG_ERROR
  });
});

describe('WaitExitCode values', () => {
  it('SUCCESS is 0', () => {
    expect(WaitExitCode.SUCCESS).toBe(0);
  });

  it('PROMPT_DETECTED is 10', () => {
    expect(WaitExitCode.PROMPT_DETECTED).toBe(10);
  });

  it('TIMEOUT is 124', () => {
    expect(WaitExitCode.TIMEOUT).toBe(124);
  });
});
