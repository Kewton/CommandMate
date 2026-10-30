/**
 * Issue #3956 (third contract): the consistency review of the settle.
 *
 *  (1) the settled frame is judged by every stage of a poll, not by the fault
 *      alone: a prompt or a new turn drawn during the settle is read as one;
 *  (2) a fault on the frame of a `Stop` poll is judged on the settled frame too,
 *      while a fault without a `Stop` (#1839) is still reported on the spot;
 *  (3) the settle keeps to `--timeout`: no sleep or re-read past it, and a
 *      re-read that does not answer is aborted.
 *
 * The pane, the server and the clock are mocked (fake timers).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { mockFetchSequence, restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';
import { HOOK_STOP_SETTLE_INTERVAL_MS, HOOK_STOP_SETTLE_MAX_MS } from '../../../../src/cli/commands/wait';

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

const FAULT_LINE = '■ Selected model is at capacity. Please try a different model.';

const readyBase = {
  isRunning: true,
  isPromptWaiting: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null as unknown,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as string,
  sessionStatusReason: 'input_prompt',
  upstreamFault: null as { id: string; matchedText: string; at: number } | null,
};

const frame = (text: string, fault = false) => ({
  content: text,
  fullOutput: text,
  realtimeSnippet: text,
  upstreamFault: fault ? { id: 'model-capacity', matchedText: FAULT_LINE, at: Date.now() } : null,
});

/** As in wait-hook-stop-settle-3956.test.ts: a turn opened at `now`, `Stop` at `now + 1 s`. */
const turn = (now: number, stopped: boolean, text: string, fault = false) => ({
  ...readyBase,
  ...frame(text, fault),
  lastStopEventAt: stopped ? now + 1_000 : now - 600_000,
  structuredEvents: {
    lastEventType: 'user_prompt_submit',
    lastEventAt: now,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
  },
});

/** An approval prompt drawn after the `Stop` of the turn at `now`. */
const promptAfterStop = (now: number) => ({
  ...turn(now, true, 'Allow command? 1. Yes 2. No'),
  isPromptWaiting: true,
  sessionStatus: 'waiting',
  sessionStatusReason: 'prompt_detected',
  promptData: {
    type: 'multiple_choice',
    question: 'Allow command?',
    options: [
      { number: 1, label: 'Yes', isDefault: true },
      { number: 2, label: 'No' },
    ],
    status: 'pending',
  },
});

/** A new turn the agent opened at `now + 2 s`, after the `Stop` at `now + 1 s`. */
const newTurnRunning = (now: number) => ({
  ...turn(now, true, 'working on the next turn'),
  sessionStatus: 'running',
  sessionStatusReason: 'thinking',
  structuredEvents: { ...turn(now, true, '').structuredEvents, lastEventAt: now + 2_000 },
});

/** The new turn's `Stop`, at `now + 3 s`. */
const newTurnStopped = (now: number) => ({
  ...turn(now, true, 'next turn done'),
  lastStopEventAt: now + 3_000,
  structuredEvents: { ...turn(now, true, '').structuredEvents, lastEventAt: now + 2_000 },
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

const currentOutputReads = (): number =>
  vi.mocked(global.fetch).mock.calls.filter(c => String(c[0]).includes('/current-output')).length;

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

/**
 * Like mockFetchSequence, but an entry `'hang'` never answers until the
 * request's signal aborts it (as fetch does).
 */
function mockFetchWithHangs(entries: Array<unknown | 'hang'>): void {
  let index = 0;
  global.fetch = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    if (String(input).includes('/api/capabilities')) {
      return Promise.resolve(jsonResponse({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    const entry = entries[index++];
    if (entry === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return Promise.resolve(jsonResponse(entry));
  }) as unknown as typeof fetch;
}

function jsonResponse(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

describe('(1) the settled frame goes through every stage of a poll (Issue #3956)', () => {
  it('a prompt drawn during the settle exits 10, not 0', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-445') },
      { data: promptAfterStop(now) },
      { data: promptAfterStop(now) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.PROMPT_DETECTED);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).not.toContain('Completed: wt1');
  });

  it('a new turn drawn during the settle is adopted and waited on, not completed', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-480') },
      // Settle: the agent has already opened its next turn.
      { data: newTurnRunning(now) },
      { data: newTurnRunning(now) },
      // The next poll: that turn's own Stop, then one settle read.
      { data: newTurnStopped(now) },
      { data: newTurnStopped(now) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(30_000);
    await pending;

    const text = stderrText();
    expect(text).toContain('Waiting: wt1 (status=running');
    expect(mockExit).toHaveBeenCalledTimes(1);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(currentOutputReads()).toBe(6);
    expect(text.indexOf('Waiting: wt1 (status=running')).toBeLessThan(text.indexOf('Completed: wt1'));
  });

  it('a settled frame that still completes is not settled a second time', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'rows 1-445') },
      { data: turn(now, true, 'rows 1-480') },
      { data: turn(now, true, 'rows 1-480') },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=hook_stop)');
    expect(currentOutputReads()).toBe(4);
  });
});

describe('(2) a fault on the frame of a Stop poll is judged on the settled frame (Issue #3956)', () => {
  it('a fault gone from the settled frame does not exit 11', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      // Mid-draw: a fault line is on the frame of the Stop poll …
      { data: turn(now, true, `rows 1-445\n${FAULT_LINE}`, true) },
      // … and the settled pane has none.
      { data: turn(now, true, 'rows 1-480') },
      { data: turn(now, true, 'rows 1-480') },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(currentOutputReads()).toBe(4);
  });

  it('a fault still on the settled frame exits 11 after the settle', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
      { data: turn(now, true, `rows 1-480\n${FAULT_LINE}`, true) },
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(stderrText()).toContain('id=model-capacity');
    expect(currentOutputReads()).toBe(3);
  });

  it('a fault without a Stop (#1839) still exits 11 on the spot', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([{ data: turn(now, false, `rows 1-200\n${FAULT_LINE}`, true) }]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(currentOutputReads()).toBe(1);
  });
});

describe('(3) the settle keeps to --timeout (Issue #3956)', () => {
  it('stops re-reading before --timeout while the pane keeps drawing', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      // The Stop poll at 5 s; --timeout 7 leaves 2 s.
      { data: turn(now, true, 'row 0') },
      ...Array.from({ length: 10 }, (_, i) => ({ data: turn(now, true, `row ${i + 1}`) })),
    ]);

    const cmd = await importWait();
    let done = false;
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault', '--timeout', '7']).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(7_000);
    expect(done).toBe(true);
    await pending;

    // Re-reads at 5.5, 6.0 and 6.5 s; one at 7.0 s would have no time left.
    expect(currentOutputReads()).toBe(2 + 3);
    expect(stderrText()).toContain('would pass --timeout/--stall-timeout');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('aborts a re-read that does not answer before --timeout', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchWithHangs([turn(now, false, 'rows 1-200'), turn(now, true, 'rows 1-480'), 'hang']);

    const cmd = await importWait();
    let done = false;
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault', '--timeout', '6']).then(() => {
      done = true;
    });
    await vi.advanceTimersByTimeAsync(6_000);
    expect(done).toBe(true);
    await pending;

    expect(stderrText()).toContain('did not answer a re-read after its stop within 500ms');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('a --timeout well past the settle leaves the bound as it was', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const settleReads = HOOK_STOP_SETTLE_MAX_MS / HOOK_STOP_SETTLE_INTERVAL_MS;
    mockFetchSequence([
      { data: turn(now, false, 'rows 1-200') },
      { data: turn(now, true, 'row 0') },
      ...Array.from({ length: settleReads }, (_, i) => ({ data: turn(now, true, `row ${i + 1}`) })),
    ]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault', '--timeout', '60']);
    await vi.advanceTimersByTimeAsync(20_000);
    await pending;

    expect(currentOutputReads()).toBe(2 + settleReads);
    expect(stderrText()).toContain('still drawing 5s after its stop');
    expect(stderrText()).not.toContain('would pass --timeout');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('a re-read that answers in time is not aborted', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockFetchWithHangs([turn(now, false, 'rows 1-200'), turn(now, true, 'rows 1-480'), turn(now, true, 'rows 1-480')]);

    const cmd = await importWait();
    const pending = cmd.parseAsync(['node', 'wait', 'wt1', '--fail-on-upstream-fault', '--timeout', '6']);
    await vi.advanceTimersByTimeAsync(6_000);
    await pending;

    expect(stderrText()).not.toContain('did not answer');
    expect(stderrText()).toContain('Completed: wt1 (basis=hook_stop)');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });
});
