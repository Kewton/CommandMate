/**
 * Issue #4535 (T15, design `send-outcome-4535.md` 第 2.1 版 §3.4・C9): the New task dialog's reading
 * of the send route's answer says "nobody knows whether it was sent" apart from "it was not sent".
 *
 * - a refusal whose body says `sendOutcome: 'unknown'` (or `'sent'`: typed, then failed) → `unknown`
 * - the send request (`/send`) running out of time before any answer → `unknown`
 * - 409 `SEND_TARGET_CHANGED` (#4534) `not_sent` → the reason why (the target changed), not a bare conflict
 *
 * Controls: the Auto-Yes request failing is still `auto_yes_failed` (nothing was sent), a `not_sent`
 * refusal keeps its kind, and `kind: 'offline'` (refused before it left) is still `failed`.
 * Every case counts the POSTs to `/send`: a reading never sends anything (INV-F1).
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { interpretSendResponse, sendNewTask, type SendNewTaskInput } from '@/lib/new-task/send-new-task';
import { ApiError, type ApiRequestOptions } from '@/lib/api-client';
import { getSendTimeoutMs } from '@/config/api-timeout-config';
import { jsonResponse } from './new-task-fixtures';

function input(autoYesDuration: SendNewTaskInput['autoYesDuration'] = null): SendNewTaskInput {
  return {
    target: { worktreeId: 'wt', instanceId: 'codex-2' },
    cliToolId: 'codex',
    content: 'go',
    autoYesDuration,
  };
}

/** A transport that answers `/send` with `send()` and arms Auto-Yes as asked. */
function transport(send: () => Promise<Response>, autoYes?: () => Promise<Response>) {
  return vi.fn(async (url: string, _options?: ApiRequestOptions) => {
    if (url.endsWith('/auto-yes')) {
      return autoYes ? autoYes() : jsonResponse({ enabled: true, expiresAt: 123 });
    }
    return send();
  });
}

const sendPosts = (request: ReturnType<typeof transport>) =>
  request.mock.calls.filter(([url]) => url.endsWith('/send')).length;

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

/** A page a proxy answers with (not JSON). */
function htmlResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    redirected: false,
    headers: new Headers({ 'content-type': 'text/html' }),
    json: async () => {
      throw new SyntaxError('Unexpected token <');
    },
    text: async () => '<html>gateway</html>',
  } as unknown as Response;
}

afterEach(() => {
  vi.useRealTimers();
});

describe('[#4535 T15] the dialog reads sendOutcome', () => {
  it('500 sendOutcome unknown is kind unknown', async () => {
    const body = { error: 'submit could not be confirmed', sendOutcome: 'unknown' };
    expect(await interpretSendResponse(jsonResponse(body, 500), { modelRequested: false })).toMatchObject({
      ok: false,
      kind: 'unknown',
      status: 500,
    });
    const request = transport(async () => jsonResponse(body, 500));
    expect(await sendNewTask(input(), request)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(sendPosts(request)).toBe(1);
  });

  it('a failed answer that says sendOutcome sent is unknown too (the text was typed)', async () => {
    const result = await interpretSendResponse(jsonResponse({ error: 'x', sendOutcome: 'sent' }, 500), {
      modelRequested: false,
    });
    expect(result).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('a send that times out is kind unknown', async () => {
    const request = transport(async () => {
      throw new ApiError('Request timed out after 600000ms', 0, undefined, 'timeout');
    });
    expect(await sendNewTask(input(), request)).toMatchObject({ ok: false, kind: 'unknown', status: 0 });
    expect(sendPosts(request)).toBe(1);
  });

  it('a 409 SEND_TARGET_CHANGED unknown is kind unknown and names the reason', async () => {
    const body = {
      error: 'x',
      code: 'SEND_TARGET_CHANGED',
      reason: 'dispatch-changed',
      target: { worktreeId: 'wt', instanceId: 'codex-2', cliToolId: 'codex' },
      current: null,
      requestId: null,
      sendOutcome: 'unknown',
    };
    const result = await interpretSendResponse(jsonResponse(body, 409), { modelRequested: false });
    expect(result).toMatchObject({ ok: false, kind: 'unknown', targetChanged: { reason: 'dispatch-changed', target: 'codex-2' } });
  });

  it('a 409 SEND_TARGET_CHANGED not_sent says why: the target changed (not a bare conflict reason)', async () => {
    const body = {
      error: 'x',
      code: 'SEND_TARGET_CHANGED',
      reason: 'target-gone',
      target: { worktreeId: 'wt', instanceId: 'codex-2', cliToolId: 'codex' },
      current: null,
      requestId: null,
      sendOutcome: 'not_sent',
    };
    const result = await interpretSendResponse(jsonResponse(body, 409), { modelRequested: false });
    expect(result).toMatchObject({ ok: false, kind: 'conflict', targetChanged: { reason: 'target-gone', target: 'codex-2' } });
  });
});

describe('[#4535 T15 r2] the dialog reads a cut-off send, a 5xx with no sendOutcome and a stalled body as unknown', () => {
  it('a send whose connection is lost (network) is kind unknown', async () => {
    const request = transport(async () => {
      throw new ApiError('Failed to fetch', 0, undefined, 'network');
    });
    expect(await sendNewTask(input(), request)).toMatchObject({ ok: false, kind: 'unknown', status: 0 });
    expect(sendPosts(request)).toBe(1);
  });

  it.each([
    ['500', 500, { error: 'tmux went away' }],
    ['502 (a proxy page)', 502, {}],
    ['504 (a proxy page)', 504, {}],
    ['503 SESSION_STARTING', 503, { error: 'starting', code: 'SESSION_STARTING' }],
    ['503 SESSION_START_FAILED', 503, { error: 'exited', code: 'SESSION_START_FAILED' }],
  ])('a %s with no sendOutcome is kind unknown', async (_name, status, body) => {
    expect(await interpretSendResponse(jsonResponse(body, status), { modelRequested: false })).toMatchObject({
      ok: false,
      kind: 'unknown',
      status,
    });
    const request = transport(async () => jsonResponse(body, status));
    expect(await sendNewTask(input(), request)).toMatchObject({ ok: false, kind: 'unknown' });
    expect(sendPosts(request)).toBe(1);
  });

  it('a send whose answer body stalls past the send timeout is kind unknown', async () => {
    vi.useFakeTimers();
    const request = transport(async () => stalledBody(500));
    const promise = sendNewTask(input(), request);
    await vi.advanceTimersByTimeAsync(getSendTimeoutMs());
    expect(await promise).toMatchObject({ ok: false, kind: 'unknown', status: 0 });
    expect(sendPosts(request)).toBe(1);
  });

  it('control: 503 SESSION_STARTING not_sent is still starting', async () => {
    const body = { error: 'starting', code: 'SESSION_STARTING', sendOutcome: 'not_sent' };
    expect(await interpretSendResponse(jsonResponse(body, 503), { modelRequested: false })).toMatchObject({
      ok: false,
      kind: 'starting',
    });
  });

  // Issue #4535 r5 (H3): the dialog reads 4xx by design §2.2 U2 and C10 too — a 4xx without
  // `sendOutcome` is not the route's (its own refusals say `not_sent`), so it is unknown.
  it('a 400 with no sendOutcome is unknown (design §2.2 U2, C10)', async () => {
    expect(await interpretSendResponse(jsonResponse({ error: 'content is required' }, 400), { modelRequested: false })).toMatchObject({
      ok: false,
      kind: 'unknown',
    });
  });

  it.each([
    ['a proxy\'s 404 page', 404, null],
    ['a 408 with no code', 408, { error: 'timeout' }],
    ['a 409 with an unknown code', 409, { error: 'x', code: 'SOMETHING_NEW' }],
  ])('%s is unknown (U2)', async (_name, status, body) => {
    const response = body === null ? htmlResponse(status) : jsonResponse(body, status);
    expect(await interpretSendResponse(response, { modelRequested: false })).toMatchObject({ ok: false, kind: 'unknown' });
  });

  it('control: a 400 with sendOutcome not_sent keeps its kind (N1)', async () => {
    const body = { error: 'content is required', sendOutcome: 'not_sent' };
    expect(await interpretSendResponse(jsonResponse(body, 400), { modelRequested: false })).toMatchObject({
      ok: false,
      kind: 'invalid',
    });
  });

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'IP_DENIED'],
  ])('control: the middleware\'s %i %s is not unknown (N6)', async (status, code) => {
    const result = await interpretSendResponse(jsonResponse({ error: 'x', code }, status), { modelRequested: false });
    expect(result).toMatchObject({ ok: false, kind: 'failed', status });
  });
});

describe('[#4535 T15] controls: what was not sent keeps its kind', () => {
  it('control: the Auto-Yes request failing is still auto_yes_failed', async () => {
    const request = transport(
      async () => jsonResponse({ id: 'm1' }, 201),
      async () => {
        throw new ApiError('Request timed out after 30000ms', 0, undefined, 'timeout');
      },
    );
    expect(await sendNewTask(input(3_600_000), request)).toMatchObject({ ok: false, kind: 'auto_yes_failed' });
    expect(sendPosts(request)).toBe(0);
  });

  it('control: a refusal before it left (offline) is still failed', async () => {
    const request = transport(async () => {
      throw new ApiError('No network connection', 0, undefined, 'offline');
    });
    expect(await sendNewTask(input(), request)).toMatchObject({ ok: false, kind: 'failed' });
  });

  it('control: 409 PROMPT_WAITING not_sent is still prompt_waiting, with no reason of a changed target', async () => {
    const body = { error: 'Answer it with respond first', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' };
    const result = await interpretSendResponse(jsonResponse(body, 409), { modelRequested: false });
    expect(result).toEqual({ ok: false, kind: 'prompt_waiting', status: 409, detail: 'Answer it with respond first' });
  });

  it('control: 500 sendOutcome not_sent is still failed (nothing was typed: sending again is safe)', async () => {
    const result = await interpretSendResponse(jsonResponse({ error: 'start failed', sendOutcome: 'not_sent' }, 500), {
      modelRequested: false,
    });
    expect(result).toMatchObject({ ok: false, kind: 'failed', status: 500 });
  });
});
