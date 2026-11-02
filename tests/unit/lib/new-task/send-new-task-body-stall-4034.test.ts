/**
 * `sendNewTask` over the real transport (Issue #4034).
 *
 * The transport now bounds a stalled body by itself, and two readers in
 * `send-new-task` swallow any read failure ("expiry unknown", "no error text").
 * If the transport's clock could fire first, those would turn a stalled read into
 * a different answer, and an armed Auto-Yes would go on to send. `withinDeadline`
 * has to keep winning, so the results stay the ones #3511 specified.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendNewTask, type SendNewTaskInput } from '@/lib/new-task/send-new-task';
import { getSendTimeoutMs, resolveDefaultTimeoutMs } from '@/config/api-timeout-config';
import { __resetApiReachabilityReporting } from '@/lib/api-client';

const headers = { 'content-type': 'application/json' };
const mockFetch = vi.fn();

function stalledBody(status: number): Response {
  return new Response(new ReadableStream<Uint8Array>(), { status, headers });
}

function input(autoYesDuration: SendNewTaskInput['autoYesDuration']): SendNewTaskInput {
  return {
    target: { worktreeId: 'wt', instanceId: 'codex-2' },
    cliToolId: 'codex',
    content: 'go',
    autoYesDuration,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  mockFetch.mockReset();
  global.fetch = mockFetch as unknown as typeof fetch;
  vi.stubGlobal('navigator', { onLine: true });
  __resetApiReachabilityReporting();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('[#4034] sendNewTask keeps its own deadline over the transport', () => {
  it('an armed Auto-Yes whose body stalls is still "unknown, nothing sent"', async () => {
    const timeout = resolveDefaultTimeoutMs('POST');
    mockFetch.mockImplementation(async () => stalledBody(200));

    const promise = sendNewTask(input(3_600_000));
    await vi.advanceTimersByTimeAsync(timeout);

    await expect(promise).resolves.toEqual({
      ok: false,
      kind: 'failed',
      status: 0,
      detail: `Request timed out after ${timeout}ms`,
      autoYesStateUnknown: true,
    });
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('a refused send whose error body stalls still fails at the send timeout', async () => {
    const timeout = getSendTimeoutMs();
    mockFetch.mockImplementation(async () => stalledBody(409));

    const promise = sendNewTask(input(null));
    await vi.advanceTimersByTimeAsync(timeout);

    await expect(promise).resolves.toEqual({
      ok: false,
      kind: 'failed',
      status: 0,
      detail: `Request timed out after ${timeout}ms`,
    });
  });

  it('a send that succeeded never reads its body, so nothing is left running', async () => {
    mockFetch.mockImplementation(async () => stalledBody(201));

    await expect(sendNewTask(input(null))).resolves.toEqual({ ok: true });
    expect(vi.getTimerCount()).toBe(0);
  });
});
