/**
 * Issue #3956 (fourth contract): the re-review of the settle.
 *
 *  (1) the ledger read that decides whether a fault frame has a `Stop` is
 *      bounded, and is not made when no `Stop` is on record;
 *  (2) a settle re-read is bounded by what is left of HOOK_STOP_SETTLE_MAX_MS
 *      too, so the verdict comes at most 5 s after the `Stop` poll;
 *  (3) the fault diagnosis is printed only for the frame the verdict is on.
 *
 * The pane, the server and the clock are mocked (fake timers).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode } from '../../../../src/cli/types';
import { HOOK_STOP_SETTLE_MAX_MS } from '../../../../src/cli/commands/wait';

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
const CONTEXT_LINE = '■ Your input exceeds the context window of this model.';

const readyBase = {
  isRunning: true,
  isPromptWaiting: false,
  lineCount: 1,
  lastCapturedLine: 1,
  promptData: null,
  autoYes: { enabled: false, expiresAt: null },
  thinking: false,
  cliToolId: 'codex',
  isSelectionListActive: false,
  lastServerResponseTimestamp: null,
  serverPollerActive: false,
  sessionStatus: 'ready' as const,
  sessionStatusReason: 'input_prompt',
};

type Fault = { id: string; matchedText: string; at: number } | null;

const frame = (text: string, fault: Fault = null) => ({
  content: text,
  fullOutput: text,
  realtimeSnippet: text,
  upstreamFault: fault,
});

const capacity = (): Fault => ({ id: 'model-capacity', matchedText: FAULT_LINE, at: Date.now() });
const contextLimit = (): Fault => ({ id: 'context-limit', matchedText: CONTEXT_LINE, at: Date.now() });

/** A turn this wait adopted at `now`; `stopped` adds its `Stop` at `now + 1 s`. */
const turn = (now: number, stopped: boolean, text: string, fault: Fault = null) => ({
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

/**
 * No turn adopted (the newest event is a `stop`), on a source that reports
 * turn boundaries, so the chat ledger is what says whether the `Stop` answered
 * the newest prompt (#1975). `stopAt` null: no `Stop` on record.
 */
const ledgerFrame = (stopAt: number | null, text: string, fault: Fault = null) => ({
  ...readyBase,
  ...frame(text, fault),
  lastStopEventAt: stopAt,
  structuredEvents: {
    lastEventType: stopAt === null ? null : 'stop',
    lastEventAt: stopAt,
    lastEventDetail: null,
    promptWaitingSince: null,
    promptWaitingSource: null,
    source: { capabilities: { supportedEvents: ['user_prompt_submit', 'stop'] } },
  },
});

type Entry = unknown | 'hang';

/**
 * fetch routed by path: `/current-output` and `/messages` each answer from
 * their own queue. `'hang'` never answers until the request's signal aborts it.
 */
function mockRoutes(currentOutput: Entry[], messages: Entry[] = []): void {
  const queues = { current: [...currentOutput], messages: [...messages] };
  global.fetch = vi.fn((input: unknown, init?: { signal?: AbortSignal }) => {
    const url = String(input);
    if (url.includes('/api/capabilities')) {
      return Promise.resolve(json({ serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] }));
    }
    const entry = url.includes('/messages') ? queues.messages.shift() : queues.current.shift();
    if (entry === 'hang') {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          const error = new Error('This operation was aborted');
          error.name = 'AbortError';
          reject(error);
        });
      });
    }
    return Promise.resolve(json(entry));
  }) as unknown as typeof fetch;
}

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

const reads = (part: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(c => String(c[0]).includes(part)).length;

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');

const occurrences = (text: string, needle: string): number => text.split(needle).length - 1;

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

describe('(1) the ledger read before a fault-frame settle is bounded (Issue #3956)', () => {
  it('a ledger that does not answer does not hold exit 11 past --timeout', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000, `rows\n${FAULT_LINE}`, capacity())], ['hang']);

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault', '--timeout', '3']);
    await vi.advanceTimersByTimeAsync(3_000);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(reads('/current-output')).toBe(1);
  });

  it('without --timeout, the ledger read is bounded by the settle bound', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([ledgerFrame(now - 1_000, `rows\n${FAULT_LINE}`, capacity())], ['hang']);

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(HOOK_STOP_SETTLE_MAX_MS);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
  });

  it('no Stop on record: the ledger is not read and the fault exits 11 at once', async () => {
    vi.useFakeTimers();
    mockRoutes([ledgerFrame(null, `rows\n${FAULT_LINE}`, capacity())], ['hang']);

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(0);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(reads('/messages')).toBe(0);
  });

  it('a ledger that answers in time still settles a fault frame whose Stop answered the prompt', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    mockRoutes(
      [
        ledgerFrame(now - 1_000, `rows\n${FAULT_LINE}`, capacity()),
        ledgerFrame(now - 1_000, 'rows 1-480'),
        ledgerFrame(now - 1_000, 'rows 1-480'),
      ],
      [prompt, prompt],
    );

    const cmd = await importWait();
    const { pending } = startWait(cmd, ['--fail-on-upstream-fault', '--timeout', '60']);
    await vi.advanceTimersByTimeAsync(5_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(reads('/messages')).toBeGreaterThanOrEqual(1);
    expect(reads('fresh=1')).toBe(2);
  });
});

describe('(2) a settle re-read is bounded by the settle bound too (Issue #3956)', () => {
  it('a re-read started at the bound does not wait past it', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([
      turn(now, false, 'rows 1-200'),
      // The Stop poll at 5 s, then re-reads at 5.5 … 9.5 s that keep changing,
      // and one at 10.0 s (the bound) that does not answer.
      turn(now, true, 'row 0'),
      ...Array.from({ length: 9 }, (_, i) => turn(now, true, `row ${i + 1}`)),
      'hang',
    ]);

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    // +1: a 0 ms abort timer fires 1 ms later, as setTimeout does.
    await vi.advanceTimersByTimeAsync(5_000 + HOOK_STOP_SETTLE_MAX_MS + 1);
    expect(state.done).toBe(true);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    expect(reads('/current-output')).toBe(12);
  });
});

describe('(3) the fault diagnosis is for the frame the verdict is on (Issue #3956)', () => {
  it('a fault on the Stop frame that the settled frame does not have leaves no diagnosis', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([
      turn(now, false, 'rows 1-200'),
      turn(now, true, `rows 1-445\n${CONTEXT_LINE}`, contextLimit()),
      turn(now, true, 'rows 1-480'),
      turn(now, true, 'rows 1-480'),
    ]);

    const cmd = await importWait();
    const { pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
    const text = stderrText();
    expect(text).not.toContain('Upstream fault on wt1');
    expect(text).not.toContain('context limit');
    expect(text).not.toContain('instances wt1 kill');
  });

  it('a fault still on the settled frame is diagnosed once, with its kill guidance', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([
      turn(now, false, 'rows 1-200'),
      turn(now, true, `rows 1-480\n${CONTEXT_LINE}`, contextLimit()),
      turn(now, true, `rows 1-480\n${CONTEXT_LINE}`, contextLimit()),
    ]);

    const cmd = await importWait();
    const { pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    const text = stderrText();
    expect(occurrences(text, 'Upstream fault on wt1')).toBe(1);
    expect(occurrences(text, 'instances wt1 kill')).toBe(1);
  });

  it('a fault without a Stop is diagnosed on the spot, as before', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    mockRoutes([turn(now, false, `rows\n${FAULT_LINE}`, capacity())]);

    const cmd = await importWait();
    const { pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(0);
    await pending;

    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.UPSTREAM_FAULT);
    expect(occurrences(stderrText(), 'Upstream fault on wt1')).toBe(1);
  });
});
