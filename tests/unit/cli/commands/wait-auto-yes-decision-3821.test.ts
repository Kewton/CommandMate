/**
 * Issue #3821: `wait` reads the server's own word that Auto-Yes left a prompt
 * to a human (`autoYesDecision.state === 'withheld'`) — no poller for the
 * instance (`server-poller-inactive`), a screen nothing here can read, … —
 * and reports it at once instead of holding it for the Auto-Yes grace
 * (#2463), with the reason on stderr. A payload without the field (an older
 * server) and an `answering` decision are held as before.
 *
 * Harness from `wait-auto-yes-grace-2463.test.ts`.
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

const HOLD_LINE = "Prompt detected; the target's Auto-Yes is answering, waiting up to";

const promptFrame = (autoYesDecision?: unknown) => ({
  isRunning: true,
  isPromptWaiting: true,
  content: 'claude',
  fullOutput: 'claude',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  thinking: false,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'waiting' as const,
  sessionStatusReason: 'prompt_detected',
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes', isDefault: true },
      { number: 2, label: 'No' },
    ],
    status: 'pending',
  },
  autoYes: { enabled: true, expiresAt: null, lastSuppression: null },
  ...(autoYesDecision === undefined ? {} : { autoYesDecision }),
});

const repeat = <T,>(data: T, times: number) => Array.from({ length: times }, () => ({ data }));
const stderr = () => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

async function startWait(...args: string[]): Promise<unknown> {
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  return createWaitCommand().parseAsync(['node', 'wait', 'wt1', ...args]);
}

describe('[#3821] wait and the Auto-Yes decision', () => {
  it.each([
    ['server-poller-inactive'],
    ['unclassified-frame'],
  ])('withheld (%s): exit 10 at once, the reason on stderr, no hold', async (reason) => {
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame({ state: 'withheld', reason, observedAt: 1 }), 5));

    const promise = startWait();
    await vi.advanceTimersByTimeAsync(5_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain(HOLD_LINE);
    expect(stderr()).toContain(`auto-yes is not answering this prompt (reason=${reason})`);
  });

  it('withheld under --on-prompt human: the reason is said, and it keeps waiting', async () => {
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame({ state: 'withheld', reason: 'server-poller-inactive', observedAt: 1 }), 3));

    void startWait('--on-prompt', 'human', '--timeout', '3');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain('auto-yes is not answering this prompt (reason=server-poller-inactive)');
  });

  it.each([
    ['answering', { state: 'answering', reason: null, observedAt: 1 }],
    ['an older server (no field)', undefined],
  ])('control — %s: held for the Auto-Yes grace, as before', async (_label, decision) => {
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame(decision), 5));

    void startWait();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain(HOLD_LINE);
  });
});
