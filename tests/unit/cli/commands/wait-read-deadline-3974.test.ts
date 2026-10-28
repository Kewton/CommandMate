/**
 * Issue #3974: the reads of `wait`'s ordinary poll — `current-output`, and the
 * chat-ledger reads of `promptLedgerStage` and `releaseOrphanTurn` — are bounded
 * by `--timeout` / `--stall-timeout`. A server that does not answer used to
 * hold the wait past them, because the loop never got back to its deadline
 * check.
 *
 * The server and the clock are mocked (fake timers). A `'hang'` entry is a
 * fetch that never answers until the request's signal aborts it.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { ExitCode, WaitExitCode } from '../../../../src/cli/types';
import { DeadlineReached, readWithinDeadlines } from '../../../../src/cli/commands/wait-timing';

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

type Entry = unknown | 'hang' | { reject: Error };

const isRejection = (entry: Entry): entry is { reject: Error } =>
  typeof entry === 'object' && entry !== null && 'reject' in entry;

function json(data: unknown): Response {
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/**
 * fetch routed by path: `/current-output` and `/messages` each answer from their
 * own queue, and the last entry of each repeats.
 */
function mockRoutes(currentOutput: Entry[], messages: Entry[] = []): void {
  const next = (queue: Entry[]): Entry => (queue.length > 1 ? queue.shift() : queue[0]);
  const queues = { current: [...currentOutput], messages: [...messages] };
  global.fetch = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    if (url.includes('/resolve-target')) {
      const requested = new URL(url).searchParams.get('instance') ?? 'claude';
      return Promise.resolve(json({ cliToolId: 'claude', instanceId: requested, resolvedBy: 'roster', conflict: null }));
    }
    const entry = url.includes('/messages') ? next(queues.messages) : next(queues.current);
    if (entry === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    if (isRejection(entry)) return Promise.reject(entry.reject);
    return Promise.resolve(json(entry));
  }) as unknown as typeof fetch;
}

const callsTo = (part: string) =>
  vi.mocked(global.fetch).mock.calls.filter(c => String(c[0]).includes(part));

const reads = (part: string): number => callsTo(part).length;

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

const readyBase = {
  isRunning: true,
  isPromptWaiting: false,
  content: 'frame',
  fullOutput: 'frame',
  realtimeSnippet: 'frame',
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'claude',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
};

/** A running frame: nothing for the ledger to decide. */
const runningFrame = () => ({ ...readyBase, sessionStatus: 'running' as const, sessionStatusReason: 'thinking' });

/**
 * No turn adopted (the newest event is a `stop`), on a source that reports turn
 * boundaries: `promptLedgerStage` reads the chat ledger (#1975).
 */
const ledgerFrame = (stopAt: number) => ({
  ...readyBase,
  lastStopEventAt: stopAt,
  structuredEvents: {
    lastEventType: 'stop',
    lastEventAt: stopAt,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
    source: { capabilities: { supportedEvents: ['user_prompt_submit', 'stop'] } },
  },
});

/**
 * A turn adopted from a `pre_tool_use` after the `Stop`, closed by the screen:
 * `releaseOrphanTurn` reads the chat ledger (#3429).
 */
const orphanFrame = (now: number) => ({
  ...readyBase,
  lastStopEventAt: now - 3_000,
  structuredEvents: {
    lastEventType: 'pre_tool_use',
    lastEventAt: now - 1_000,
    lastEventDetail: 'AskUserQuestion',
    promptWaitingSince: null,
    promptWaitingSource: null,
    source: {
      cliToolId: 'claude',
      capabilities: {
        supportedEvents: ['stop', 'session_start', 'session_end', 'user_prompt_submit', 'pre_tool_use', 'post_tool_use'],
        configScope: 'worktree',
        decisionTimeoutSeconds: 30,
        permissionHookPredictsDialog: true,
        sessionStartMayArriveLate: false,
        permissionReplyReleasesPrompt: true,
        eventIdentity: null,
        resync: 'none',
      },
    },
    turnId: `turn-${now - 1_000}-435`,
    openedAt: now - 1_000,
    closedAt: now,
    closedBy: 'scraper_evidence',
    pendingDecisions: [],
    dialogPendingMaxMs: { predicted: 20_000, confirmed: 1_800_000 },
  },
});

const importWait = async () =>
  (await import('../../../../src/cli/commands/wait')).createWaitCommand();

/** Starts a wait and reports whether it has returned yet. */
function startWait(cmd: Awaited<ReturnType<typeof importWait>>, args: string[]) {
  const state = { done: false };
  const pending = cmd.parseAsync(['node', 'wait', 'wt1', ...args]).then(() => {
    state.done = true;
  });
  return { state, pending };
}

describe('a poll read that does not answer ends at the deadline (Issue #3974)', () => {
  it('current-output: --timeout 2 exits 124 at 2 s', async () => {
    vi.useFakeTimers();
    mockRoutes(['hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '2']);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).toContain('Timeout: wt1 exceeded 2s');
    // Not a failed poll, and not retried.
    expect(stderrText()).not.toContain('Poll error');
    expect(reads('/current-output')).toBe(1);
  });

  it('current-output: --stall-timeout 2 exits 124 at 2 s', async () => {
    vi.useFakeTimers();
    mockRoutes(['hang']);

    const { state, pending } = startWait(await importWait(), ['--stall-timeout', '2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).toContain('Stall timeout: wt1 no output for 2s');
    expect(reads('/current-output')).toBe(1);
  });

  it('current-output on a later poll: bounded by what is left of --timeout', async () => {
    vi.useFakeTimers();
    mockRoutes([runningFrame(), 'hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '7']);
    // Poll at 0 s answers; the poll at 5 s hangs and is cut at 7 s.
    await vi.advanceTimersByTimeAsync(6_999);
    expect(state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(reads('/current-output')).toBe(2);
  });

  it('promptLedgerStage: a ledger that does not answer ends at --timeout, not as "unreadable"', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000)], ['hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('Completed: wt1');
    // No second poll: the deadline was decided on the way back to the top.
    expect(reads('/current-output')).toBe(1);
    expect(reads('/messages')).toBe(1);
  });

  it('releaseOrphanTurn: a ledger that does not answer ends at --timeout', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([orphanFrame(now)], ['hang']);

    const { state, pending } = startWait(await importWait(), ['--instance', 'claude', '--timeout', '2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('Completed: wt1');
    expect(reads('/current-output')).toBe(1);
    expect(reads('/messages')).toBe(1);
  });
});

describe('reads that answer, and failures that are not the deadline, are as before (Issue #3974)', () => {
  it('without --timeout / --stall-timeout, no signal is passed to the poll reads', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    // The newest prompt was answered by the Stop: completes on the first poll.
    mockRoutes([ledgerFrame(now - 1_000)], [[{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }]]);

    const { state, pending } = startWait(await importWait(), []);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    for (const part of ['/current-output', '/messages']) {
      expect(reads(part)).toBe(1);
      const init = callsTo(part)[0][1] as RequestInit;
      expect('signal' in init).toBe(false);
    }
  });

  it('with --timeout, reads that answer complete as before, each with a signal', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000)], [[{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }]]);

    const { state, pending } = startWait(await importWait(), ['--timeout', '30']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=hook_stop)');
    for (const part of ['/current-output', '/messages']) {
      const init = callsTo(part)[0][1] as RequestInit;
      expect(init.signal).toBeInstanceOf(AbortSignal);
      expect(init.signal?.aborted).toBe(false);
    }
  });

  it('a network failure that is not the deadline still ends the wait as before, not as 124', async () => {
    vi.useFakeTimers();
    mockRoutes([{ reject: new TypeError('fetch failed') }]);

    const { state, pending } = startWait(await importWait(), ['--timeout', '30']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).not.toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(mockExit).toHaveBeenCalledWith(ExitCode.DEPENDENCY_ERROR);
  });

  it('a ledger that fails (not the deadline) is still "unreadable" and the wait completes on the frame', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000)], [{ reject: new TypeError('fetch failed') }]);

    const { state, pending } = startWait(await importWait(), ['--timeout', '30']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    await pending;

    expect(stderrText()).toContain('could not read the message ledger');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=scraper_ready)');
  });
});

describe('the frame a settle returned is judged even after the deadline (Issue #3974, review P2)', () => {
  it('a ledger read with no time left on the settled frame does not turn its completion into 124', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    // Poll at 0 s: the ledger answers at once (hook_stop) and the settle starts;
    // its fresh re-read at 0.5 s hangs and is cut at 1 s, leaving the 0 s frame.
    mockRoutes([ledgerFrame(now - 1_000), 'hang'], [prompt]);

    const { state, pending } = startWait(await importWait(), ['--timeout', '1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(true);
    await pending;

    expect(reads('fresh=1')).toBe(1);
    // The settled frame's own ledger read is not started: no time is left.
    expect(reads('/messages')).toBe(1);
    expect(stderrText()).toContain('judging the settled frame alone');
    expect(stderrText()).not.toContain('Timeout: wt1');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(stderrText()).toContain('Completed: wt1 (basis=scraper_ready)');
  });

  it('on an ordinary poll, a ledger that does not answer still ends at --timeout (124)', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000)], ['hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('judging the settled frame alone');
    expect(reads('fresh=1')).toBe(0);
  });
});

/**
 * The frame a settle re-read: a turn opened after the poll's `Stop` (no `Stop`
 * for it yet), already closed by the screen — `releaseOrphanTurn` reads the
 * ledger for it on the re-judge.
 */
const turnOpenedDuringSettle = (now: number) => {
  const base = orphanFrame(now);
  return {
    ...base,
    content: 'drawn during the settle',
    fullOutput: 'drawn during the settle',
    realtimeSnippet: 'drawn during the settle',
    lastStopEventAt: now - 1_000,
    structuredEvents: {
      ...base.structuredEvents,
      lastEventAt: now + 200,
      turnId: `turn-${now + 200}-1`,
      openedAt: now + 200,
      closedAt: now + 400,
    },
  };
};

describe('a settled frame that does not complete asks the deadline before sleeping (Issue #3974, review 2 P2)', () => {
  it('its ledger cut by --timeout: 124 at the deadline, not one interval later', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    // 0 s: Stop poll, ledger answers (hook_stop), settle starts. 0.5 s: the
    // re-read shows a new turn; the settle stops there (no time for another).
    // The re-judge reads the ledger for that turn, which hangs until 1 s.
    mockRoutes([ledgerFrame(now - 1_000), turnOpenedDuringSettle(now)], [prompt, 'hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(true);
    await pending;

    expect(reads('fresh=1')).toBe(1);
    expect(reads('/messages')).toBe(2);
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).toContain('Timeout: wt1 exceeded 1s');
    expect(stderrText()).not.toContain('Completed: wt1');
  });

  it('with time left, the next poll comes one interval later, as before', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    // Same frames; the ledger answers (prompt answered), so the orphan hold
    // starts and the re-judge waits.
    mockRoutes([ledgerFrame(now - 1_000), turnOpenedDuringSettle(now)], [prompt]);

    const { state, pending } = startWait(await importWait(), ['--timeout', '30', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(false);
    const plainPolls = () => reads('/current-output') - reads('fresh=1');
    expect(plainPolls()).toBe(1);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state.done).toBe(false);
    expect(plainPolls()).toBe(2);
    expect(mockExit).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(30_000);
    await pending;
  });
});

describe('the ledger note on an aborted read (Issue #3974, review 2 P3)', () => {
  it('a ledger cut by --timeout on an ordinary poll prints no "judged from the frame alone" note', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000)], ['hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '2']);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('could not read the message ledger');
  });

  it('on the settled frame, only the settled-frame note is printed', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    mockRoutes([ledgerFrame(now - 1_000), turnOpenedDuringSettle(now)], [prompt, 'hang']);

    const { state, pending } = startWait(await importWait(), ['--timeout', '1', '--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(state.done).toBe(true);
    await pending;

    expect(stderrText()).toContain('judging the settled frame alone');
    expect(stderrText()).not.toContain('could not read the message ledger');
  });

  it('readNewestPromptAt: quiet only when asked and aborted; other failures print the note', async () => {
    const { readNewestPromptAt } = await import('../../../../src/cli/commands/wait-turn-boundary');
    const { ApiClient } = await import('../../../../src/cli/utils/api-client');
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });
    const data = ledgerFrame(Date.now()) as unknown as Parameters<typeof readNewestPromptAt>[3];

    mockRoutes([], ['hang']);
    const aborted = new AbortController();
    const quiet = readNewestPromptAt(client, 'wt1', {}, data, aborted.signal, true);
    aborted.abort();
    await expect(quiet).resolves.toEqual({ readable: false });
    expect(stderrText()).not.toContain('could not read the message ledger');

    // Not asked (as faultFrameHasStop calls it): the note, as before.
    mockRoutes([], ['hang']);
    const loud = new AbortController();
    const asBefore = readNewestPromptAt(client, 'wt1', {}, data, loud.signal);
    loud.abort();
    await expect(asBefore).resolves.toEqual({ readable: false });
    expect(stderrText()).toContain('could not read the message ledger');

    // Asked, but a failure that is not the abort: the note.
    mockConsoleError.mockClear();
    mockRoutes([], [{ reject: new TypeError('fetch failed') }]);
    const failed = readNewestPromptAt(client, 'wt1', {}, data, new AbortController().signal, true);
    await expect(failed).resolves.toEqual({ readable: false });
    expect(stderrText()).toContain('could not read the message ledger');
  });
});

describe('readWithinDeadlines (Issue #3974)', () => {
  it('with neither deadline set, the read gets no signal', async () => {
    const read = vi.fn((signal?: AbortSignal) => Promise.resolve(signal));
    await expect(readWithinDeadlines({}, Date.now(), Date.now(), read)).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledWith();
  });

  it('with no time left on --timeout, no read is started', async () => {
    const now = Date.now();
    const read = vi.fn(() => Promise.resolve('x'));
    await expect(readWithinDeadlines({ timeout: 2 }, now - 2_000, now, read)).rejects.toBeInstanceOf(DeadlineReached);
    expect(read).not.toHaveBeenCalled();
  });

  it('a read that swallows its abort is still the deadline', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    // Like readNewestPromptAt: never throws, answers "unreadable" once aborted.
    const read = (signal?: AbortSignal) =>
      new Promise<{ readable: boolean }>(resolve => {
        signal?.addEventListener('abort', () => resolve({ readable: false }));
      });
    const pending = readWithinDeadlines({ stallTimeout: 3 }, now, now, read);
    const assertion = expect(pending).rejects.toBeInstanceOf(DeadlineReached);
    await vi.advanceTimersByTimeAsync(3_000);
    await assertion;
  });

  it('a failure that is not the abort is rethrown as it came', async () => {
    const error = new Error('boom');
    await expect(
      readWithinDeadlines({ timeout: 30 }, Date.now(), Date.now(), () => Promise.reject(error)),
    ).rejects.toBe(error);
  });

  it('a deadline beyond what a timer can hold leaves the read unbounded', async () => {
    const read = vi.fn((signal?: AbortSignal) => Promise.resolve(signal));
    await expect(readWithinDeadlines({ timeout: 3_000_000 }, Date.now(), Date.now(), read)).resolves.toBeUndefined();
  });
});
