/**
 * Issue #3956 (fifth contract): the ledger read that confirms the `Stop` of a
 * fault frame and the settle after it share one bound, measured from the
 * `Stop` poll, so a slow ledger is not followed by a full 5 s settle.
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

type Entry = unknown | 'hang' | { delayMs: number; data: unknown };

const isDelayed = (entry: Entry): entry is { delayMs: number; data: unknown } =>
  typeof entry === 'object' && entry !== null && 'delayMs' in entry;

/**
 * fetch routed by path: `/current-output` and `/messages` each answer from
 * their own queue. `'hang'` never answers until the request's signal aborts it;
 * `{ delayMs, data }` answers `data` after `delayMs`.
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
    if (isDelayed(entry)) {
      return new Promise(resolve => setTimeout(() => resolve(json(entry.data)), entry.delayMs));
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

describe('one bound for the ledger read and the settle after it (Issue #3956)', () => {
  it('a ledger that answers late leaves the settle only what is left of the bound', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    mockRoutes(
      [
        // The Stop poll at 0 s, with a fault on the frame.
        ledgerFrame(now - 1_000, `rows\n${FAULT_LINE}`, capacity()),
        // The pane keeps drawing through every re-read.
        ...Array.from({ length: 10 }, (_, i) => ledgerFrame(now - 1_000, `row ${i + 1}`)),
      ],
      // The ledger answers at 4 s; the settled poll's own ledger read at once.
      [{ delayMs: 4_000, data: prompt }, prompt],
    );

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    // +1: a 0 ms abort timer fires 1 ms later, as setTimeout does.
    await vi.advanceTimersByTimeAsync(HOOK_STOP_SETTLE_MAX_MS + 1);
    expect(state.done).toBe(true);
    await pending;

    // Re-reads at 4.5 s and 5.0 s only, then judged on the last frame read.
    expect(reads('fresh=1')).toBe(2);
    expect(stderrText()).toContain('still drawing 5s after its stop');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });

  it('a ledger that answers at once leaves the settle its whole bound, as before', async () => {
    vi.useFakeTimers();
    const now = Date.now();
    const prompt = [{ role: 'user', timestamp: new Date(now - 5_000).toISOString() }];
    mockRoutes(
      [
        ledgerFrame(now - 1_000, `rows\n${FAULT_LINE}`, capacity()),
        ...Array.from({ length: 10 }, (_, i) => ledgerFrame(now - 1_000, `row ${i + 1}`)),
      ],
      [prompt, prompt],
    );

    const cmd = await importWait();
    const { state, pending } = startWait(cmd, ['--fail-on-upstream-fault']);
    await vi.advanceTimersByTimeAsync(HOOK_STOP_SETTLE_MAX_MS + 1);
    expect(state.done).toBe(true);
    await pending;

    expect(reads('fresh=1')).toBe(10);
    expect(stderrText()).toContain('still drawing 5s after its stop');
    expect(mockExit).toHaveBeenCalledWith(WaitExitCode.SUCCESS);
  });
});
