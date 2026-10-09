/**
 * Issue #3179 — `commandmate wait` treats a launch in progress as work in
 * progress: never exit 10, never "not started" while the pane is being made.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { VerifyExitCode, WaitExitCode } from '../../../../src/cli/types';

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
  isRunning: true,
  isPromptWaiting: false,
  content: '',
  fullOutput: '',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'antigravity',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'running' as const,
};

const starting = {
  ...baseOutput,
  sessionStatusReason: 'starting',
  startingSince: 1_000,
};
const ready = { ...baseOutput, sessionStatus: 'ready' as const, startingSince: null };

const repeat = <T,>(data: T, times: number) => Array.from({ length: times }, () => ({ data }));

describe('[#3179] wait while the agent is launching', () => {
  it('keeps waiting through a long launch and completes when it is ready', async () => {
    vi.useFakeTimers();
    mockFetchSequence([...repeat(starting, 15), { data: ready }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(90_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('does not exit 10 even if a launch frame carries dialog or unclassified flags', async () => {
    // Defensive: a payload that says "starting" is read as starting, whatever
    // else rides on it — the unclassified dwell (60 s) would otherwise fire here.
    vi.useFakeTimers();
    const noisy = {
      ...starting,
      isUnclassifiedActive: true,
      isSelectionListActive: true,
      isPromptWaiting: true,
      promptData: { type: 'yes_no', question: 'Trust?', options: ['yes', 'no'], status: 'pending' },
    };
    mockFetchSequence([...repeat(noisy, 15), { data: ready }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(90_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('is not "not started" while the launch has not created the pane yet', async () => {
    vi.useFakeTimers();
    mockFetchSequence([{ data: { ...starting, isRunning: false } }, { data: ready }]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });

  it('reports a launch that failed and left no session as not started, not completed', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      { data: { ...starting, isRunning: false } },
      { data: { ...baseOutput, isRunning: false, sessionStatus: 'idle' as const, startingSince: null } },
    ]);

    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const promise = createWaitCommand().parseAsync(['node', 'wait', 'wt1']);
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(VerifyExitCode.NOT_STARTED);
  });
});
