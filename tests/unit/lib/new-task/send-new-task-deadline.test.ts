/**
 * sendNewTask always settles (Issue #3511): each request — headers and JSON
 * body — must finish within the transport's own timeout for it, since the
 * dialog cannot be closed until the send settles.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { sendNewTask, withinDeadline, type SendNewTaskInput } from '@/lib/new-task/send-new-task';
import { getSendTimeoutMs, resolveDefaultTimeoutMs } from '@/config/api-timeout-config';
import { jsonResponse } from './new-task-fixtures';

const HOUR = 3_600_000;

/** Headers arrive with `status`; the body never does. */
function stalledBody(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'application/json' }),
    json: () => new Promise(() => {}),
    text: () => new Promise(() => {}),
  } as unknown as Response;
}

function input(autoYesDuration: SendNewTaskInput['autoYesDuration']): SendNewTaskInput {
  return {
    target: { worktreeId: 'wt', instanceId: 'codex-2' },
    cliToolId: 'codex',
    content: 'go',
    autoYesDuration,
  };
}

/** Run `sendNewTask` and report whether it has settled after `ms`. */
async function settleAfter(promise: Promise<unknown>, ms: number) {
  let settled = false;
  void promise.then(() => {
    settled = true;
  });
  await vi.advanceTimersByTimeAsync(ms);
  return settled;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('[#3511] sendNewTask — a body that never finishes', () => {
  const autoYesTimeout = resolveDefaultTimeoutMs('POST');

  it('fails an armed Auto-Yes whose body stalls at the POST timeout, without sending', async () => {
    const request = vi.fn(async (url: string) => (url.endsWith('/auto-yes') ? stalledBody(200) : jsonResponse({}, 201)));
    const promise = sendNewTask(input(HOUR), request);

    expect(await settleAfter(promise, autoYesTimeout - 1)).toBe(false);
    expect(await settleAfter(promise, 1)).toBe(true);
    // Issue #3563: the timeout's clock is not the server's enabling time, so no expiry is claimed.
    expect(await promise).toEqual({
      ok: false,
      kind: 'failed',
      status: 0,
      detail: `Request timed out after ${autoYesTimeout}ms`,
      autoYesStateUnknown: true,
    });
    expect(request.mock.calls.map(([url]) => url)).toEqual(['/api/worktrees/wt/auto-yes']);
  });

  it('fails a refused Auto-Yes whose error body stalls as auto_yes_failed, nothing armed', async () => {
    const request = vi.fn(async () => stalledBody(409));
    const promise = sendNewTask(input(HOUR), request);
    await vi.advanceTimersByTimeAsync(autoYesTimeout);
    expect(await promise).toEqual({
      ok: false,
      kind: 'auto_yes_failed',
      status: 0,
      detail: `Request timed out after ${autoYesTimeout}ms`,
    });
    expect(request).toHaveBeenCalledTimes(1);
  });

  it('fails a send whose error body stalls at the send timeout', async () => {
    const request = vi.fn(async () => stalledBody(409));
    const promise = sendNewTask(input(null), request);
    expect(await settleAfter(promise, getSendTimeoutMs() - 1)).toBe(false);
    expect(await settleAfter(promise, 1)).toBe(true);
    expect(await promise).toMatchObject({ ok: false, kind: 'failed', detail: `Request timed out after ${getSendTimeoutMs()}ms` });
  });

  it('answers at once and leaves no timer behind when the bodies arrive (negative control)', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/auto-yes') ? jsonResponse({ enabled: true, expiresAt: 123 }) : jsonResponse({ id: 'm1' }, 201),
    );
    const promise = sendNewTask(input(HOUR), request);
    expect(await settleAfter(promise, 0)).toBe(true);
    expect(await promise).toEqual({ ok: true, armedAutoYes: { enabled: true, expiresAt: 123 } });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('withinDeadline passes a rejection through untouched', async () => {
    const boom = new Error('boom');
    await expect(withinDeadline(() => Promise.reject(boom), 10)).rejects.toBe(boom);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('[#3563] sendNewTask — an Auto-Yes expiry is never guessed', () => {
  it('never reports an expiry later than the server enabled it + duration, however late the body times out', async () => {
    const enabledAt = Date.now();
    const serverExpiry = enabledAt + HOUR;
    const request = vi.fn(async (url: string) => (url.endsWith('/auto-yes') ? stalledBody(200) : jsonResponse({}, 201)));
    const promise = sendNewTask(input(HOUR), request);
    await vi.advanceTimersByTimeAsync(resolveDefaultTimeoutMs('POST'));
    const result = await promise;
    expect(Date.now()).toBeGreaterThan(enabledAt);
    expect(result.armedAutoYes === undefined || result.armedAutoYes.expiresAt <= serverExpiry).toBe(true);
    expect(result.armedAutoYes).toBeUndefined();
    expect(result.autoYesStateUnknown).toBe(true);
  });

  it('treats a 2xx without a readable expiry as unknown and still sends', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/auto-yes') ? jsonResponse({ enabled: true }) : jsonResponse({ id: 'm1' }, 201),
    );
    const result = await sendNewTask(input(HOUR), request);
    expect(result).toEqual({ ok: true, autoYesStateUnknown: true });
  });

  it('keeps the server-reported expiry as confirmed (negative control)', async () => {
    const request = vi.fn(async (url: string) =>
      url.endsWith('/auto-yes') ? jsonResponse({ enabled: true, expiresAt: 42 }) : jsonResponse({ id: 'm1' }, 201),
    );
    const result = await sendNewTask(input(HOUR), request);
    expect(result).toEqual({ ok: true, armedAutoYes: { enabled: true, expiresAt: 42 } });
  });

  it('a resend after the timeout arms again rather than skipping', async () => {
    const calls: string[] = [];
    const request = vi.fn(async (url: string) => {
      calls.push(url);
      return url.endsWith('/auto-yes') ? jsonResponse({ enabled: true, expiresAt: 7 }) : jsonResponse({ id: 'm1' }, 201);
    });
    // The dialog records nothing as armed after an unknown result, so it passes the chosen duration again.
    await sendNewTask(input(HOUR), request);
    expect(calls).toEqual(['/api/worktrees/wt/auto-yes', '/api/worktrees/wt/send']);
  });
});
