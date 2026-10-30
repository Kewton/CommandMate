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
import { fetchPromptRowsSince } from '../../../../src/cli/utils/reply-ledger';
import {
  CAPABILITIES,
  RELAY_CREATED,
  calls,
  frame,
  mockServer,
  start,
  verifyRun,
} from './command-deadline-server';

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

const stderrText = (): string => mockConsoleError.mock.calls.map(c => String(c[0])).join('\n');
const firstExit = (): unknown => mockExit.mock.calls[0]?.[0];

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

describe('the degrading catches on the way rethrow a deadline, through the command (Issue #3983)', () => {
  it('positive: a roster read that does not answer on a server without resolve-target (session-target) is 124, not "using --agent as given"', async () => {
    mockServer({
      '/api/capabilities': { status: 200, data: { ...CAPABILITIES, capabilities: [] } },
      'GET /api/worktrees/wt1$': 'hang',
      '/current-output': frame,
    });
    await expectEndsAt(await start('wait', ['wt1', '--instance', 'codex-2', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(stderrText()).not.toContain('could not read the agent-instance roster');
    expect(calls('GET', '/current-output')).toBe(0);
  });

  it('negative: the same roster read refused is still the Warning, and the wait goes on', async () => {
    mockServer({
      '/api/capabilities': { status: 200, data: { ...CAPABILITIES, capabilities: [] } },
      'GET /api/worktrees/wt1$': { reject: new TypeError('fetch failed') },
      '/current-output': frame,
    });
    const run = await start('wait', ['wt1', '--instance', 'codex-2', '--timeout', '2']);
    await vi.advanceTimersByTimeAsync(100);
    await run.pending;

    expect(stderrText()).toContain('could not read the agent-instance roster');
    expect(firstExit()).toBe(WaitExitCode.SUCCESS);
  });

  // `ask` is fetchPromptRowsSince's one caller, and it reads a deadline there
  // as "no extra rows" — the same thing the swallowing catch returned — so the
  // rethrow has no exit code or line of its own to show through the command.
  // It is pinned at the helper instead, with the client `ask` hands it.
  it('positive: fetchPromptRowsSince (reply-ledger) rejects with the deadline instead of answering null', async () => {
    mockServer({ '/messages': 'hang' });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' }).withDeadline(Date.now() + 1_000);
    const pending = fetchPromptRowsSince(client, 'wt1', 'claude', 0).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await pending).toBeInstanceOf(DeadlineExceededError);
  });

  it('negative: fetchPromptRowsSince still answers null for a 500', async () => {
    mockServer({ '/messages': { status: 500, data: { error: 'boom' } } });
    const client = new ApiClient({ baseUrl: 'http://localhost:3999' }).withDeadline(Date.now() + 1_000);
    expect(await fetchPromptRowsSince(client, 'wt1', 'claude', 0)).toBeNull();
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

  // Review P1: real reads take time, so a poll that slept the full interval
  // read a few ms past the deadline — and that read used to be skipped.
  it.each([7, 10])(
    'positive: with 1 ms per request, a run that passes in the last interval reports its verdict (`--timeout %i`)',
    async (timeoutSec) => {
      let runReads = 0;
      mockServer({
        'POST /verify': { delayMs: 1, status: 202, data: { runId: 7 } },
        '/verify/runs/7': { delayMs: 1, data: () => verifyRun(++runReads < 3 ? 'running' : 'passed') },
      });
      const run = await start('verify', ['wt1', '--timeout', String(timeoutSec)]);
      await vi.advanceTimersByTimeAsync(timeoutSec * 1_000 + 5_000);
      await run.pending;

      expect(runReads).toBe(3);
      expect(firstExit()).toBe(VerifyExitCode.SUCCESS);
    },
  );

  // Re-review P3-A: 5 001 ms left after the first read is more than one interval,
  // so the sleep is not cut short and the next read starts 1 ms before the
  // deadline; it must not be cut there.
  it('positive: a read that starts just before the deadline still brings the verdict (`--timeout 6`, POST 997 ms, GET 2 ms)', async () => {
    let runReads = 0;
    mockServer({
      'POST /verify': { delayMs: 997, status: 202, data: { runId: 7 } },
      '/verify/runs/7': { delayMs: 2, data: () => verifyRun(++runReads < 2 ? 'running' : 'passed') },
    });
    const run = await start('verify', ['wt1', '--timeout', '6']);
    await vi.advanceTimersByTimeAsync(10_000);
    await run.pending;

    expect(runReads).toBe(2);
    expect(firstExit()).toBe(VerifyExitCode.SUCCESS);
  });

  it('positive: a run still running is 124 right after the read taken at the deadline', async () => {
    let runReads = 0;
    mockServer({
      'POST /verify': { delayMs: 1, status: 202, data: { runId: 7 } },
      '/verify/runs/7': { delayMs: 1, data: () => (runReads++, verifyRun('running')) },
    });
    // POST ends at 1 ms; reads at 1, 5 002 and 7 000 ms (the sleep stops at the deadline).
    await expectEndsAt(await start('verify', ['wt1', '--timeout', '7']), 7_001);

    expect(runReads).toBe(3);
    expect(firstExit()).toBe(VerifyExitCode.TIMEOUT);
    expect(stderrText()).toContain('exceeded 7s');
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

  it('negative: a /send that returns past the deadline is 124 that says the message was sent, with no poll', async () => {
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
  });

  it('negative: with --async, a /send that returns past the deadline keeps its relay (exit 0, no cancel)', async () => {
    mockServer({
      'POST /api/relays': RELAY_CREATED,
      'POST /send': { delayMs: 3_000, data: { id: 'm1', timestamp: new Date().toISOString() } },
      '/current-output': frame,
    });
    const run = await start('ask', [
      'wt1', 'hello', '--instance', 'claude', '--async', '--reply-to', 'wt0@claude', '--timeout', '2',
    ]);
    // Neither the relay POST nor the send is cut at 2 s.
    await vi.advanceTimersByTimeAsync(2_500);
    expect(run.state.done).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    await run.pending;

    expect(firstExit()).toBe(ExitCode.SUCCESS);
    expect(calls('POST', '/api/relays')).toBe(1);
    expect(calls('POST', '/send')).toBe(1);
    expect(calls('POST', '/cancel')).toBe(0);
    expect(calls('GET', '/current-output')).toBe(0);
  });

  it('positive: with --async, a --reply-to resolution that does not answer is 124 at 2 s, no relay and nothing sent', async () => {
    mockServer({ 'wt0/resolve-target': 'hang', 'POST /api/relays': RELAY_CREATED });
    await expectEndsAt(
      await start('ask', [
        'wt1', 'hello', '--instance', 'claude', '--async', '--reply-to', 'wt0@claude', '--timeout', '2',
      ]),
      2_000,
    );

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(calls('POST', '/api/relays')).toBe(0);
    expect(calls('POST', '/send')).toBe(0);
  });

  it('positive: a resolve-target that does not answer ends `ask --timeout 2` at 2 s with 124, nothing sent', async () => {
    mockServer({ '/resolve-target': 'hang' });
    await expectEndsAt(await start('ask', ['wt1', 'hello', '--instance', 'Reviewer', '--timeout', '2']), 2_000);

    expect(firstExit()).toBe(WaitExitCode.TIMEOUT);
    expect(calls('POST', '/send')).toBe(0);
  });
});
