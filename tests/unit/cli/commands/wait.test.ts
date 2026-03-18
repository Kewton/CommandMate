/**
 * wait Command Tests
 * Issue #518, #520
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
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
  vi.useRealTimers();
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
  thinking: false, // [S2-01] boolean type (was '' string)
  thinkingMessage: null,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'idle' as const, // Issue #520: default for isRunning=false
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
      sessionStatus: 'waiting' as const,
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

describe('Issue #520: sessionStatus completion detection', () => {
  it('exits 0 when sessionStatus is ready (task completed, Path B)', async () => {
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('continues polling when sessionStatus is running, then exits 0 on ready', async () => {
    vi.useFakeTimers();
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    // Advance past the poll interval to trigger second poll
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    // Should have logged a waiting message for the first poll
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Waiting:')
    );
  });

  it('continues polling when sessionStatus is waiting (selection list, no prompt)', async () => {
    vi.useFakeTimers();
    const waitingOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'claude_selection_list',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: waitingOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('prompt detection (exit 10) takes priority over sessionStatus', async () => {
    const promptWithWaiting = {
      ...baseOutput,
      isRunning: true,
      isPromptWaiting: true,
      sessionStatus: 'waiting' as const,
      sessionStatusReason: 'yes_no_prompt',
      promptData: { type: 'yes_no', question: 'Allow?', options: ['y', 'n'], status: 'pending' },
    };
    mockFetchSequence([{ data: promptWithWaiting }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('falls back to isRunning-only detection when sessionStatus is undefined (old server)', async () => {
    vi.useFakeTimers();
    // Old server does not return sessionStatus
    const oldServerRunning = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: undefined,
      sessionStatusReason: undefined,
    };
    const oldServerStopped = {
      ...baseOutput,
      isRunning: false,
      sessionStatus: undefined,
      sessionStatusReason: undefined,
    };
    mockFetchSequence([{ data: oldServerRunning }, { data: oldServerStopped }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    // First poll should have continued (waiting message)
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('Waiting:')
    );
  });

  it('exits 0 when sessionStatus is ready with no_recent_output reason', async () => {
    const noRecentOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'no_recent_output',
    };
    mockFetchSequence([{ data: noRecentOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('sessionStatus ready resolves before stall-timeout fires', async () => {
    vi.useFakeTimers();
    // First poll: running, second poll: ready (within stall-timeout window)
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      content: 'output-1',
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      content: 'output-1', // same content (would stall)
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1', '--stall-timeout', '300']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('exits 0 when sessionStatus is idle and isRunning is false (Path A)', async () => {
    const idleOutput = {
      ...baseOutput,
      isRunning: false,
      sessionStatus: 'idle' as const,
      sessionStatusReason: 'session_not_running',
    };
    mockFetchSequence([{ data: idleOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    await cmd.parseAsync(['node', 'wait', 'wt1']);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('includes sessionStatus in progress message', async () => {
    vi.useFakeTimers();
    const runningOutput = {
      ...baseOutput,
      isRunning: true,
      isComplete: false,
      isPromptWaiting: false,
      sessionStatus: 'running' as const,
      sessionStatusReason: 'thinking_indicator',
    };
    const readyOutput = {
      ...baseOutput,
      isRunning: true,
      sessionStatus: 'ready' as const,
      sessionStatusReason: 'input_prompt',
    };
    mockFetchSequence([{ data: runningOutput }, { data: readyOutput }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    const promise = cmd.parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(6000);
    await promise;
    // Verify progress message includes sessionStatus [DR1-05]
    expect(mockConsoleError).toHaveBeenCalledWith(
      expect.stringContaining('status=running')
    );
  });
});
