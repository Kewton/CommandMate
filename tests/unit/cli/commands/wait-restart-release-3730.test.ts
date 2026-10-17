/**
 * `wait` says when the prompt it reports sits on an instance whose Auto-Yes the
 * last server restart released (Issue #3730).
 *
 * `autoYes: { enabled: false, stopReason: 'server-restart' }` adds one stderr
 * line to every hand-back (a parsed prompt, a selection list, `--on-prompt
 * human`). The branches themselves do not move: exit 10 stays the answer for a
 * real prompt only, the exit-10 payload on stdout is unchanged, and a frame
 * with no prompt is not turned into one by the reason.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeAll(async () => {
  await import('../../../../src/cli/commands/wait');
  await import('../../../../src/cli/utils/api-client');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
});

const RESTART = { enabled: false, expiresAt: null, stopReason: 'server-restart', lastSuppression: null };

function frame(autoYes: unknown, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    isRunning: true,
    isPromptWaiting: true,
    content: 'claude',
    fullOutput: 'claude',
    realtimeSnippet: '',
    lineCount: 1,
    lastCapturedLine: 1,
    promptData: {
      type: 'yes_no',
      question: 'Allow this command?',
      options: ['yes', 'no'],
      status: 'pending',
    },
    ...(autoYes === undefined ? {} : { autoYes }),
    thinking: false,
    cliToolId: 'claude',
    sessionStatus: 'waiting',
    sessionStatusReason: 'prompt_detected',
    isSelectionListActive: false,
    lastServerResponseTimestamp: null,
    serverPollerActive: false,
    ...overrides,
  };
}

const stderr = () => mockConsoleError.mock.calls.map((c) => String(c[0])).join('\n');
const NOTICE = 'auto-yes was released by a server restart on wt1';

async function runWait(...args: string[]): Promise<void> {
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', 'wt1', ...args]);
}

describe('[#3730] wait names a restart release on the hand-back', () => {
  it('a prompt: exit 10 as before, one stderr line, stdout payload unchanged', async () => {
    mockFetchSequence([{ data: frame(RESTART) }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain(NOTICE);
    expect(stderr()).toContain('commandmate auto-yes wt1 --enable');
    const payload = String(mockConsoleLog.mock.calls[0][0]);
    expect(payload).not.toContain('server-restart');
  });

  it('--on-prompt human: says it while it keeps waiting', async () => {
    vi.useFakeTimers();
    mockFetchSequence([{ data: frame(RESTART) }]);
    const promise = runWait('--on-prompt', 'human', '--timeout', '3');
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(stderr()).toContain('Waiting for human response...');
    expect(stderr()).toContain(NOTICE);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
  });

  it('a selection list: exit 10 as before, with the line', async () => {
    mockFetchSequence([
      { data: frame(RESTART, { isPromptWaiting: false, promptData: null, isSelectionListActive: true, sessionStatusReason: 'selection_list' }) },
    ]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain(NOTICE);
  });

  it('negative: no prompt on screen is not made a hand-back by the reason', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      {
        data: frame(RESTART, {
          isPromptWaiting: false,
          promptData: null,
          sessionStatus: 'running',
          sessionStatusReason: 'thinking_indicator',
          thinking: true,
        }),
      },
    ]);
    const promise = runWait('--timeout', '3');
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain(NOTICE);
  });

  it.each([
    ['Auto-Yes off with no reason', { enabled: false, expiresAt: null, lastSuppression: null }],
    ['another reason', { enabled: false, expiresAt: null, stopReason: 'expired', lastSuppression: null }],
    ['a server older than the field (no autoYes)', undefined],
  ])('negative: %s — exit 10, no line', async (_label, autoYes) => {
    mockFetchSequence([{ data: frame(autoYes) }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain('released by a server restart');
  });
});
