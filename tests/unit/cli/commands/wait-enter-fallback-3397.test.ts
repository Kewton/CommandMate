/**
 * `wait` says when Auto-Yes pressed Enter on the prompt it reports (Issue #3397).
 *
 * `autoYes.lastEnterFallback` with `currentPrompt: true` adds one stderr line to
 * the prompt report — `sent`, or `no-effect` (the screen outlived the Enter and
 * is a human's again). A record about another screen, or none, adds nothing.
 * stdout (the exit-10 payload) is unchanged either way.
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

const SENT = {
  outcome: 'sent',
  promptType: 'multiple_choice',
  refusalReason: 'unsupported_dialog_layout',
  sentAt: Date.now(),
  at: Date.now(),
  currentPrompt: true,
};

/** A prompt CommandMate could not read, with Auto-Yes OFF so the report is immediate. */
const promptFrame = (lastEnterFallback: unknown) => ({
  isRunning: true,
  isPromptWaiting: true,
  content: 'claude',
  fullOutput: 'claude',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: {
    type: 'multiple_choice',
    question: 'Which one?',
    options: [
      { number: 1, label: 'A', isDefault: true },
      { number: 2, label: 'B' },
    ],
    status: 'pending',
  },
  promptAnswerable: false,
  autoYes: {
    enabled: false,
    expiresAt: null,
    lastSuppression: null,
    ...(lastEnterFallback === undefined ? {} : { lastEnterFallback }),
  },
  thinking: false,
  cliToolId: 'claude',
  sessionStatus: 'waiting',
  sessionStatusReason: 'prompt_detected',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: true,
});

const stderr = () => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

async function runWait(...args: string[]): Promise<void> {
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  await createWaitCommand().parseAsync(['node', 'wait', 'wt1', ...args]);
}

describe('[#3397] wait reports the Enter Auto-Yes sent to this prompt', () => {
  it('sent: one line on stderr, exit 10, stdout unchanged', async () => {
    mockFetchSequence([{ data: promptFrame(SENT) }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain('auto-yes sent Enter to this prompt (CommandMate could not read it)');
    expect(stderr()).toContain('refusal=unsupported_dialog_layout');
    const payload = JSON.parse(String(mockConsoleLog.mock.calls[0][0])) as Record<string, unknown>;
    expect(JSON.stringify(payload)).not.toContain('lastEnterFallback');
  });

  it('no-effect: says the screen is still up and is a human\'s', async () => {
    mockFetchSequence([{ data: promptFrame({ ...SENT, outcome: 'no-effect' }) }]);
    await runWait();

    expect(stderr()).toContain('the same screen is still up (no-effect)');
    expect(stderr()).not.toContain('(CommandMate could not read it)');
  });

  it('an outcome this CLI does not know is named verbatim', async () => {
    mockFetchSequence([{ data: promptFrame({ ...SENT, outcome: 'something-new' }) }]);
    await runWait();

    expect(stderr()).toContain('outcome=something-new');
  });

  it('--on-prompt human says it too, while it keeps waiting', async () => {
    vi.useFakeTimers();
    mockFetchSequence([{ data: promptFrame(SENT) }]);
    const promise = runWait('--on-prompt', 'human', '--timeout', '3');
    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(stderr()).toContain('Waiting for human response...');
    expect(stderr()).toContain('auto-yes sent Enter to this prompt');
  });

  it.each([
    ['a record about another screen', { ...SENT, currentPrompt: false }],
    ['no record', null],
    ['a server older than the field', undefined],
  ])('%s: no line', async (_label, record) => {
    mockFetchSequence([{ data: promptFrame(record) }]);
    await runWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain('auto-yes sent Enter');
    expect(stderr()).not.toContain('Enter record');
  });
});
