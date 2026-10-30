/**
 * Issue #3983: `--timeout` of `wait` / `ask` / `verify` is the deadline of the
 * whole command, passed to every read it makes — the ones before the poll
 * included — and a read it ends is exit 124, never swallowed into a degraded
 * path by the catch that sits between it and the action.
 *
 * Every case runs the real command (action → helper → `ApiClient`); only
 * `fetch` and the clock are faked. A `'hang'` route never answers until the
 * request's signal aborts it; a `'stall-body'` route answers its headers at
 * once and then never finishes the body, ignoring the signal — the shape that
 * only a bound on the body read itself can end.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { restoreFetch } from '../../../helpers/mock-api';
import { WaitExitCode, VerifyExitCode, ExitCode } from '../../../../src/cli/types';
import {
  ApiClient,
  ApiError,
  DeadlineExceededError,
  isDeadlineExceeded,
} from '../../../../src/cli/utils/api-client';

const mockExit = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
const mockConsoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
const mockConsoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

beforeEach(() => {
  vi.useFakeTimers();
  // Never the default port: fetch is faked, but the URL should not name 3000.
  vi.stubEnv('CM_PORT', '3999');
});

afterEach(() => {
  restoreFetch();
  mockExit.mockClear();
  mockConsoleLog.mockClear();
  mockConsoleError.mockClear();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

/**
 * `'hang'`, `'stall-body'`, a function of the request returning the body,
 * `{ status, data }`, `{ reject }`, `{ delayMs, data }`, or any other object as
 * the body of a 200.
 */
type Route = 'hang' | 'stall-body' | ((url: URL, init: RequestInit | undefined) => unknown) | object;

function json(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  } as unknown as Response;
}

/** Headers at once, then a body that never ends (and ignores the signal). */
function stalledBody(): Response {
  const never = () => new Promise<never>(() => {});
  return {
    ok: true,
    status: 200,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: never,
    text: never,
  } as unknown as Response;
}

function hang(init: RequestInit | undefined): Promise<Response> {
  return new Promise((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      const error = new Error('This operation was aborted');
      error.name = 'AbortError';
      reject(error);
    });
  });
}

const CAPABILITIES = { serverVersion: '0.0.0-test', capabilities: ['resolve-session-target'] };

/**
 * fetch routed by the first key the URL contains (`METHOD path-part`, or a bare
 * path part for any method). Capabilities and resolve-target answer by default.
 */
function mockServer(routes: Record<string, Route>): void {
  const table: Record<string, Route> = {
    '/api/capabilities': { status: 200, data: CAPABILITIES },
    '/resolve-target': (url) => ({
      cliToolId: 'claude',
      instanceId: url.searchParams.get('instance') ?? 'claude',
      resolvedBy: 'roster',
      conflict: null,
    }),
    ...routes,
  };
  // Own routes first, so a test can override the defaults above.
  const keys = [...Object.keys(routes), ...Object.keys(table).filter(k => !(k in routes))];
  global.fetch = vi.fn((input: unknown, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const key = keys.find(k => {
      const [m, part] = k.includes(' ') ? k.split(' ') : [undefined, k];
      return (m === undefined || m === method) && url.pathname.concat(url.search).includes(part);
    });
    if (key === undefined) return Promise.resolve(json({ error: 'no route' }, 404));
    const route = table[key];
    if (route === 'hang') return hang(init);
    if (route === 'stall-body') return Promise.resolve(stalledBody());
    if (typeof route === 'function') return Promise.resolve(json(route(url, init)));
    const spec = route as { reject?: Error; delayMs?: number; status?: number; data?: unknown };
    if (spec.reject) return Promise.reject(spec.reject);
    if (typeof spec.delayMs === 'number') {
      return new Promise(resolve => setTimeout(() => resolve(json(spec.data)), spec.delayMs));
    }
    if (typeof spec.status === 'number') return Promise.resolve(json(spec.data, spec.status));
    // Anything else is the body of a 200.
    return Promise.resolve(json(route));
  }) as unknown as typeof fetch;
}

const calls = (method: string, part: string): number =>
  vi.mocked(global.fetch).mock.calls.filter(([input, init]) =>
    ((init as RequestInit | undefined)?.method ?? 'GET') === method && String(input).includes(part),
  ).length;

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
const firstExit = (): unknown => mockExit.mock.calls[0]?.[0];

const frame = {
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

const verifyRun = (status: string) => ({
  run: {
    id: 7,
    worktreeId: 'wt1',
    instanceId: null,
    taskId: null,
    trigger: 'wait',
    status,
    startedAt: '2026-10-30T00:00:00.000Z',
    finishedAt: status === 'running' ? null : '2026-10-30T00:00:01.000Z',
    gates: [],
  },
});

/** Runs a command and reports whether it has returned yet. */
async function start(
  name: 'wait' | 'ask' | 'verify',
  args: string[],
): Promise<{ state: { done: boolean }; pending: Promise<void> }> {
  const mod =
    name === 'wait'
      ? (await import('../../../../src/cli/commands/wait')).createWaitCommand()
      : name === 'ask'
        ? (await import('../../../../src/cli/commands/ask')).createAskCommand()
        : (await import('../../../../src/cli/commands/verify')).createVerifyCommand();
  const state = { done: false };
  const pending = mod.parseAsync(['node', name, ...args]).then(() => {
    state.done = true;
  });
  return { state, pending };
}

/** Advance to just short of `ms`, check it is still running, then to `ms`. */
async function expectEndsAt(run: { state: { done: boolean }; pending: Promise<void> }, ms: number) {
  await vi.advanceTimersByTimeAsync(ms - 1);
  expect(run.state.done).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(run.state.done).toBe(true);
  await run.pending;
}

describe('ApiClient.withDeadline (Issue #3983)', () => {
  it('ends a request that does not answer with a DeadlineExceededError (exit 124)', async () => {
    mockServer({ '/x': 'hang' });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' }).withDeadline(Date.now() + 1_000);
    const pending = client.get('/x').catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    const error = await pending;
    expect(error).toBeInstanceOf(DeadlineExceededError);
    expect((error as ApiError).exitCode).toBe(WaitExitCode.TIMEOUT);
  });

  it('bounds post / patch / rawGet, and the body read of rawGet', async () => {
    mockServer({ 'POST /p': 'hang', 'PATCH /q': 'hang', '/r': 'stall-body' });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' }).withDeadline(Date.now() + 1_000);
    const post = client.post('/p', {}).catch((e: unknown) => e);
    const patch = client.patch('/q', {}).catch((e: unknown) => e);
    const response = await client.rawGet('/r');
    const body = response.json().catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(isDeadlineExceeded(await post)).toBe(true);
    expect(isDeadlineExceeded(await patch)).toBe(true);
    expect(isDeadlineExceeded(await body)).toBe(true);
  });

  it('sends nothing once the deadline has passed', async () => {
    mockServer({ '/x': { status: 200, data: {} } });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' }).withDeadline(Date.now() - 1);
    await expect(client.get('/x')).rejects.toBeInstanceOf(DeadlineExceededError);
  });

  it('keeps the mark when wrapped: transportError / cause', () => {
    const inner = new DeadlineExceededError();
    expect(isDeadlineExceeded(new ApiError('x', 1, undefined, undefined, inner))).toBe(true);
    expect(isDeadlineExceeded(new Error('x', { cause: inner }))).toBe(true);
    expect(isDeadlineExceeded(new ApiError('x', 1))).toBe(false);
  });

  it('without a deadline, the client is unchanged and requests carry no signal', async () => {
    mockServer({ '/x': { status: 200, data: { a: 1 } } });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' });
    expect(client.withDeadline(undefined)).toBe(client);
    await client.post('/x', {});
    const init = vi.mocked(global.fetch).mock.calls[0][1] as RequestInit;
    expect('signal' in init).toBe(false);
  });
});

describe('wait: the reads before the poll are inside --timeout (Issue #3983)', () => {
  it('positive: a task-ledger GET that does not answer ends `wait --timeout 2 --verify` at 2 s with 124', async () => {
    mockServer({ '/tasks': 'hang', '/current-output': frame, 'POST /verify': { status: 202, data: { runId: 7 } } });
    await expectEndsAt(await start('wait', ['wt1', '--timeout', '2', '--verify']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('could not read the task ledger');
    // Nothing after it: no poll, no verification.
    expect(calls('GET', '/current-output')).toBe(0);
    expect(calls('POST', '/verify')).toBe(0);
  });

  it('positive: a task-ledger body that stalls ends the wait the same way', async () => {
    mockServer({ '/tasks': 'stall-body', '/current-output': frame });
    await expectEndsAt(await start('wait', ['wt1', '--timeout', '2', '--verify']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(calls('GET', '/current-output')).toBe(0);
    expect(calls('POST', '/verify')).toBe(0);
  });

  it('positive: a resolve-target that does not answer ends `wait --instance <alias> --timeout 2` with 124', async () => {
    mockServer({ '/resolve-target': 'hang', '/current-output': frame });
    await expectEndsAt(await start('wait', ['wt1', '--instance', 'Reviewer', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    // Not degraded to "use the selector as an instance id" and waited on.
    expect(stderrText()).not.toContain('could not resolve --instance');
    expect(calls('GET', '/current-output')).toBe(0);
  });

  it('positive: a capabilities probe (rawGet) that does not answer, or stalls its body, is 124 too', async () => {
    for (const route of ['hang', 'stall-body'] as const) {
      mockServer({ '/api/capabilities': route, '/current-output': frame });
      await expectEndsAt(await start('wait', ['wt1', '--instance', 'Reviewer', '--timeout', '2']), 2_000);
      expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
      expect(stderrText()).not.toContain('could not resolve --instance');
      expect(calls('GET', '/current-output')).toBe(0);
      mockExit.mockClear();
      mockConsoleError.mockClear();
    }
  });

  it('negative: a 500 from the task ledger is still a Note, and verification resolves its own task', async () => {
    mockServer({
      '/tasks': { status: 500, data: { error: 'boom' } },
      '/current-output': frame,
      'POST /verify': { status: 202, data: { runId: 7 } },
      '/verify/runs/7': verifyRun('passed'),
    });
    const run = await start('wait', ['wt1', '--timeout', '2', '--verify']);
    await vi.advanceTimersByTimeAsync(100);
    await run.pending;

    expect(stderrText()).toContain('could not read the task ledger');
    expect(firstExit()).toBe(WaitExitCode.SUCCESS);
    const post = vi.mocked(global.fetch).mock.calls.find(([u, i]) =>
      String(u).includes('/verify') && (i as RequestInit).method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body)).taskId).toBeUndefined();
  });

  it('negative: a refused connection to resolve-target still degrades to the selector as an instance id', async () => {
    mockServer({ '/resolve-target': { reject: new TypeError('fetch failed') }, '/current-output': frame });
    const run = await start('wait', ['wt1', '--instance', 'codex-2', '--timeout', '2']);
    await vi.advanceTimersByTimeAsync(100);
    await run.pending;

    expect(stderrText()).toContain("could not resolve --instance 'codex-2'");
    expect(firstExit()).toBe(WaitExitCode.SUCCESS);
    const polled = vi.mocked(global.fetch).mock.calls.find(([u]) => String(u).includes('/current-output'));
    expect(new URL(String(polled?.[0])).searchParams.get('instance')).toBe('codex-2');
  });

  it('negative: with time left the in-flight task id reaches verification (#1620)', async () => {
    mockServer({
      '/tasks': { status: 200, data: { tasks: [{ id: 'task-1', status: 'running' }] } },
      '/current-output': frame,
      'POST /verify': { status: 202, data: { runId: 7 } },
      '/verify/runs/7': verifyRun('passed'),
    });
    const run = await start('wait', ['wt1', '--timeout', '60', '--verify']);
    await vi.advanceTimersByTimeAsync(100);
    await run.pending;

    expect(firstExit()).toBe(WaitExitCode.SUCCESS);
    const post = vi.mocked(global.fetch).mock.calls.find(([u, i]) =>
      String(u).includes('/verify') && (i as RequestInit).method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body)).taskId).toBe('task-1');
  });

  it('negative: a ready frame read just before the deadline completes (exit 0), even past it', async () => {
    mockServer({ '/current-output': { delayMs: 1_990, data: frame } });
    const run = await start('wait', ['wt1', '--timeout', '2']);
    await vi.advanceTimersByTimeAsync(5_000);
    await run.pending;

    expect(firstExit()).toBe(WaitExitCode.SUCCESS);
  });

  it('negative: verification after the wait is not cut by --timeout', async () => {
    let runReads = 0;
    mockServer({
      '/tasks': { status: 200, data: { tasks: [] } },
      '/current-output': frame,
      'POST /verify': { status: 202, data: { runId: 7 } },
      '/verify/runs/7': () => verifyRun(++runReads < 3 ? 'running' : 'passed'),
    });
    const run = await start('wait', ['wt1', '--timeout', '2', '--verify']);
    await vi.advanceTimersByTimeAsync(20_000);
    await run.pending;

    expect(runReads).toBe(3);
    expect(firstExit()).toBe(VerifyExitCode.SUCCESS);
  });

  it('negative: without --timeout a slow task ledger is waited for, as before', async () => {
    mockServer({
      '/tasks': { delayMs: 10_000, data: { tasks: [{ id: 'task-1', status: 'running' }] } },
      '/current-output': frame,
      'POST /verify': { status: 202, data: { runId: 7 } },
      '/verify/runs/7': verifyRun('passed'),
    });
    const run = await start('wait', ['wt1', '--verify']);
    await vi.advanceTimersByTimeAsync(10_100);
    await run.pending;

    expect(firstExit()).toBe(VerifyExitCode.SUCCESS);
    const post = vi.mocked(global.fetch).mock.calls.find(([u, i]) =>
      String(u).includes('/verify') && (i as RequestInit).method === 'POST');
    expect(JSON.parse(String((post?.[1] as RequestInit).body)).taskId).toBe('task-1');
  });
});

describe('verify --timeout bounds the start and the run reads (Issue #3983)', () => {
  it('positive: a run GET that does not answer ends `verify --timeout 2` at 2 s with 124', async () => {
    mockServer({ 'POST /verify': { status: 202, data: { runId: 7 } }, '/verify/runs/7': 'hang' });
    await expectEndsAt(await start('verify', ['wt1', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(VerifyExitCode.TIMEOUT);
    expect(stderrText()).toContain('exceeded 2s');
  });

  it('positive: a start POST that does not answer is 124 as well', async () => {
    mockServer({ 'POST /verify': 'hang' });
    await expectEndsAt(await start('verify', ['wt1', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(VerifyExitCode.TIMEOUT);
  });

  it('negative: without --timeout a slow run read is waited for', async () => {
    mockServer({
      'POST /verify': { status: 202, data: { runId: 7 } },
      '/verify/runs/7': { delayMs: 10_000, data: verifyRun('passed') },
    });
    const run = await start('verify', ['wt1']);
    await vi.advanceTimersByTimeAsync(10_000);
    await run.pending;

    expect(firstExit()).toBe(VerifyExitCode.SUCCESS);
  });
});

describe('ask: --timeout covers the round trip, not the reading of the reply (Issue #3983)', () => {
  it('negative: a reply-ledger GET that does not answer after completion falls back to the pane within the grace, not 124', async () => {
    mockServer({
      'POST /send': { status: 200, data: { id: 'm1', timestamp: new Date().toISOString() } },
      '/current-output': frame,
      '/messages': 'hang',
      'POST /capture': { status: 200, data: { output: 'the pane reply' } },
    });
    const run = await start('ask', ['wt1', 'hello', '--instance', 'claude', '--timeout', '2']);
    // The reply grace (15 s) bounds each read after the turn ended.
    await vi.advanceTimersByTimeAsync(15_000);
    await run.pending;

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(calls('POST', '/capture')).toBeGreaterThan(0);
    expect(mockConsoleLog.mock.calls.map(c => String(c[0])).join('\n')).toContain('the pane reply');
  });

  it('negative: a /send that returns past the deadline is 124 that says the message was sent, with no poll and no relay cancel', async () => {
    mockServer({
      'POST /send': { delayMs: 3_000, data: { id: 'm1', timestamp: new Date().toISOString() } },
      '/current-output': frame,
    });
    const run = await start('ask', ['wt1', 'hello', '--instance', 'claude', '--timeout', '2']);
    // The send is not cut at 2 s: it is in flight until it returns.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await run.pending;

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(stderrText()).toContain('The message was sent');
    expect(calls('GET', '/current-output')).toBe(0);
    expect(calls('POST', '/api/relays')).toBe(0);
  });

  it('positive: a resolve-target that does not answer ends `ask --timeout 2` at 2 s with 124, nothing sent', async () => {
    mockServer({ '/resolve-target': 'hang' });
    await expectEndsAt(await start('ask', ['wt1', 'hello', '--instance', 'Reviewer', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(calls('POST', '/send')).toBe(0);
  });
});
