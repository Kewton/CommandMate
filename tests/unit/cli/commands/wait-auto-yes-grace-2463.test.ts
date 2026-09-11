/**
 * Issue #2463: `wait` / `ask` in `--on-prompt agent` mode must not report a
 * prompt the target's own Auto-Yes is answering.
 *
 * Measured 2026-09-09: Command Code 1.51.3 delegated to Antigravity with `ask`,
 * Antigravity running under Auto-Yes. Antigravity raised its permission dialog
 * for `git log && npm test`; `ask` exited 10 on the spot; the delegating agent
 * did what exit 10 tells it to — stop and report to its human — and
 * Antigravity's Auto-Yes then answered the dialog and finished the turn with
 * nobody waiting for it. A take without Auto-Yes was right to exit 10. `wait`
 * never read the flag that told the two apart.
 *
 * The hold mirrors `decidePromptPush()` (src/lib/push/prompt-push-gate.ts):
 * `auto-yes-answering` is held; `auto-yes-inactive` and `policy-withheld` still
 * exit 10 at once. Every held case below has a negative control next to it.
 */

import { describe, it, expect, vi, afterEach, beforeAll } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

// Load the modules under real timers. The first test switches to fake timers
// before anything else, and a first import made under them has not finished
// resolving when the test advances the clock, so its polls never run.
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

/** The stderr line the hold prints when it opens. */
const HOLD_LINE = "Prompt detected; the target's Auto-Yes is answering, waiting up to";

const autoYesOn = { enabled: true, expiresAt: null };

const baseOutput = {
  isRunning: true,
  isComplete: false,
  isPromptWaiting: false,
  isGenerating: false,
  content: 'agy',
  fullOutput: 'agy',
  realtimeSnippet: '',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: autoYesOn,
  thinking: false,
  thinkingMessage: null,
  cliToolId: 'antigravity',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: true,
};

/** Antigravity's numbered permission dialog, published as a prompt since #2364. */
const promptFrame = (autoYes: unknown) => ({
  ...baseOutput,
  isPromptWaiting: true,
  sessionStatus: 'waiting' as const,
  sessionStatusReason: 'prompt_detected',
  promptData: {
    type: 'multiple_choice',
    question: 'Do you want to proceed?',
    options: [
      { number: 1, label: 'Yes, allow git log && npm test', isDefault: true },
      { number: 2, label: 'No' },
    ],
    status: 'pending',
  },
  autoYes,
});

/** A policy verdict recorded against the dialog at `at`. */
const withheldAt = (at: number) => ({
  ...autoYesOn,
  lastSuppression: {
    reason: 'deny-pattern',
    mode: 'allow-listed',
    promptType: 'multiple_choice',
    pattern: 'npm test',
    at,
  },
});

/** The agent back at work after the dialog was answered. */
const running = {
  ...baseOutput,
  sessionStatus: 'running' as const,
  sessionStatusReason: 'thinking_indicator',
};

/** The turn finished. */
const ready = { ...baseOutput, sessionStatus: 'ready' as const, sessionStatusReason: 'input_prompt' };

const repeat = <T,>(data: T, times: number) => Array.from({ length: times }, () => ({ data }));

const stderr = () => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

const holdLines = () =>
  mockConsoleError.mock.calls.filter(c => String(c[0]).startsWith(HOLD_LINE)).length;

async function startWait(...args: string[]): Promise<unknown> {
  const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
  return createWaitCommand().parseAsync(['node', 'wait', 'wt1', ...args]);
}

describe("Issue #2463: a prompt the target's Auto-Yes is answering is held, not reported", () => {
  it('keeps polling through the prompt and completes once Auto-Yes has answered it', async () => {
    vi.useFakeTimers();
    mockFetchSequence([
      { data: promptFrame(autoYesOn) },
      { data: promptFrame(autoYesOn) },
      { data: running },
      { data: ready },
    ]);

    const promise = startWait();
    await vi.advanceTimersByTimeAsync(20_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    // stdout is the exit-10 payload and nothing else, so a hold writes nothing there.
    expect(mockConsoleLog).not.toHaveBeenCalled();
    // One line for the whole hold, not one per poll.
    expect(holdLines()).toBe(1);
    expect(stderr()).toContain(`${HOLD_LINE} 30s… (wt1)`);
    expect(stderr()).toContain('Prompt on wt1 cleared after 10s');
  });

  it('exits 10 once the grace runs out with the prompt still open (negative control 1)', async () => {
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame(autoYesOn), 10));

    const promise = startWait();
    await vi.advanceTimersByTimeAsync(25_000);
    // Six polls, 25 s held: still inside the window.
    expect(mockExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output).toMatchObject({
      worktreeId: 'wt1',
      cliToolId: 'antigravity',
      type: 'multiple_choice',
      question: 'Do you want to proceed?',
    });
    // Nothing withheld the answer; Auto-Yes simply did not give one.
    expect(output.autoYesSuppression).toBeUndefined();
    expect(stderr()).toContain("the target's Auto-Yes did not answer the prompt on wt1 within 30s");
  });

  // getAutoYesState folds every stop (expired, stop pattern, consecutive
  // errors) into `enabled: false`, so `enabled` is the one field to read.
  it.each([
    ['off', { enabled: false, expiresAt: null }],
    ['expired', { enabled: false, expiresAt: null, stopReason: 'expired' }],
  ])('exits 10 at once when Auto-Yes is %s (negative control 2)', async (_label, autoYes) => {
    // One response only: a hold would ask again and find nothing to read.
    mockFetchSequence([{ data: promptFrame(autoYes) }]);

    await startWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain(HOLD_LINE);
  });

  it('exits 10 at once, with autoYesSuppression, when the policy withheld the answer', async () => {
    mockFetchSequence([{ data: promptFrame(withheldAt(Date.now())) }]);

    await startWait();

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.autoYesSuppression).toMatchObject({ reason: 'deny-pattern', pattern: 'npm test' });
    expect(stderr()).not.toContain(HOLD_LINE);
  });

  it('ends the hold as soon as the policy withholds the answer inside the grace', async () => {
    vi.useFakeTimers();
    const secondPollAt = Date.now() + 5_000;
    mockFetchSequence([
      // The server's poller has not judged the dialog yet: nothing recorded.
      { data: promptFrame(autoYesOn) },
      ...repeat(promptFrame(withheldAt(secondPollAt)), 8),
    ]);

    const promise = startWait();
    // Well short of the 30 s window: a hold that ignored the verdict would
    // still be sleeping here, and `await promise` would never settle.
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.autoYesSuppression).toMatchObject({ reason: 'deny-pattern' });
    expect(stderr()).toContain(HOLD_LINE);
    expect(stderr()).toContain('auto-yes suppressed this prompt by contract policy');
  });

  it('does not count a suppression left over from an earlier prompt', async () => {
    // Stamped ten minutes ago and no longer being re-stamped, so it withheld
    // some earlier prompt. This one is Auto-Yes's to answer and is held — and
    // when the grace runs out the stale record is not reported as the reason.
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame(withheldAt(Date.now() - 10 * 60_000)), 10));

    const promise = startWait();
    await vi.advanceTimersByTimeAsync(35_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(holdLines()).toBe(1);
    const output = JSON.parse(mockConsoleLog.mock.calls[0][0]);
    expect(output.autoYesSuppression).toBeUndefined();
    expect(stderr()).not.toContain('auto-yes suppressed');
  });

  it('gives a new prompt a window of its own once the previous one cleared', async () => {
    vi.useFakeTimers();
    // Three prompt polls (0-10 s), one working poll, five more prompt polls
    // (20-40 s). One window across both runs would have closed at 30 s.
    mockFetchSequence([
      ...repeat(promptFrame(autoYesOn), 3),
      { data: running },
      ...repeat(promptFrame(autoYesOn), 5),
      { data: ready },
    ]);

    const promise = startWait();
    await vi.advanceTimersByTimeAsync(50_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(holdLines()).toBe(2);
  });

  it.each([['--stall-timeout'], ['--timeout']])(
    'reports the prompt as exit 10, not 124, when %s would lapse inside the grace',
    async (flag) => {
      vi.useFakeTimers();
      mockFetchSequence(repeat(promptFrame(autoYesOn), 10));

      // 12 s: the poll at 10 s is the last one before the deadline.
      const promise = startWait(flag, '12');
      await vi.advanceTimersByTimeAsync(20_000);
      await promise;

      expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
      expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
      expect(stderr()).toContain('the next poll would pass --timeout/--stall-timeout');
    },
  );

  it('--auto-yes-grace 0 exits 10 at once, as before #2463', async () => {
    mockFetchSequence([{ data: promptFrame(autoYesOn) }]);

    await startWait('--auto-yes-grace', '0');

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).not.toContain(HOLD_LINE);
  });

  it('--auto-yes-grace <seconds> sets the window', async () => {
    vi.useFakeTimers();
    mockFetchSequence(repeat(promptFrame(autoYesOn), 6));

    const promise = startWait('--auto-yes-grace', '10');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(mockExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(stderr()).toContain(`${HOLD_LINE} 10s…`);
  });

  it.each(['soon', '2.5', '30s'])(
    'refuses --auto-yes-grace %s with exit 2 before polling',
    async (value) => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;

      await startWait('--auto-yes-grace', value);

      expect(mockExit).toHaveBeenCalledWith(ExitCode.CONFIG_ERROR);
      expect(stderr()).toContain('--auto-yes-grace must be a whole number of seconds');
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it('leaves --on-prompt human as it was', async () => {
    vi.useFakeTimers();
    mockFetchSequence([{ data: promptFrame(autoYesOn) }, { data: ready }]);

    const promise = startWait('--on-prompt', 'human');
    await vi.advanceTimersByTimeAsync(6_000);
    await promise;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderr()).toContain('Prompt detected on wt1. Waiting for human response...');
    expect(stderr()).not.toContain(HOLD_LINE);
  });
});

describe('Issue #2463: ask shares the hold', () => {
  it('holds for the default grace when called the way ask calls it', async () => {
    // `ask` passes timeout / instance / token and no grace (src/cli/commands/ask.ts).
    vi.useFakeTimers();
    mockFetchSequence([
      { data: promptFrame(autoYesOn) },
      { data: promptFrame(autoYesOn) },
      { data: running },
      { data: ready },
    ]);

    const { pollWorktree } = await import('../../../../src/cli/commands/wait');
    const { ApiClient } = await import('../../../../src/cli/utils/api-client');
    const promise = pollWorktree(new ApiClient(), 'wt1', {
      timeout: 1800,
      instance: undefined,
      token: undefined,
    });
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await promise;

    expect(result.exitCode).toBe(WaitExitCode.SUCCESS);
    expect(result.output).toBeUndefined();
    expect(stderr()).toContain(`${HOLD_LINE} 30s…`);
  });
});

describe('Issue #2463: the grace is documented where callers look', () => {
  /** What a user sees from `commandmate wait --help` (see wait-help-1926.test.ts). */
  async function helpText(): Promise<string> {
    const { createWaitCommand } = await import('../../../../src/cli/commands/wait');
    const cmd = createWaitCommand();
    let out = '';
    cmd.configureOutput({ writeOut: (str) => { out += str; } });
    cmd.outputHelp();
    return out;
  }

  it('wait --help names the flag, its default and what still exits 10', async () => {
    const help = await helpText();

    expect(help).toContain('--auto-yes-grace <seconds>');
    const [, section] = help.split("A prompt the target's Auto-Yes is answering");
    expect(section).toBeDefined();
    expect(section).toContain('default: 30');
    expect(section).toContain('autoYesSuppression');
    expect(section).toContain('--auto-yes-grace 0');
    expect(section).toContain('--on-prompt human');
    expect(section).toContain('124');
  });

  it('both guides describe it, including the one a delegating agent reads', async () => {
    const { AGENT_OPERATIONS_GUIDE, AGENT_DELEGATION_GUIDE } = await import(
      '../../../../src/cli/docs/agent-operations'
    );

    expect(AGENT_OPERATIONS_GUIDE).toContain('--auto-yes-grace');
    expect(AGENT_OPERATIONS_GUIDE).toContain('Issue #2463');
    // The delegation section is read by the agent that branches on exit 10.
    expect(AGENT_DELEGATION_GUIDE).toContain('Issue #2463');
    expect(AGENT_DELEGATION_GUIDE).toMatch(/Auto-Yes on, ask gives it up to\s+30 s/);
    expect(AGENT_DELEGATION_GUIDE).toContain('autoYesSuppression');
  });
});
