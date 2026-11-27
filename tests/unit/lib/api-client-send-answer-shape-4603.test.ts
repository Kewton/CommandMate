/**
 * Issue #4603 (design `send-outcome-4535.md` §2.2 D2–D4): only the screen's send reads the shape of
 * a 2xx answer.
 *
 * - INV-Q2 (T2): every other `fetchApi` caller reads the same 2xx answers exactly as before — a
 *   non-JSON body is `ApiError('Unexpected response format', <2xx>)`, an empty `application/json`
 *   body is the raw `SyntaxError` of `response.json()`, and `{}` resolves as `{}`. Green before and
 *   after the fix; red if the send's reading were applied to `fetchApi` as a whole.
 * - T4: a 2xx the CLI reads as `sent` (S1 a ChatMessage, S2 a ChatMessage with
 *   `sendOutcome: 'unknown'`) still resolves on the send, with the row as the server gave it (its
 *   `timestamp` revived, its `brief` kept).
 * - r2 T5: the send's predicate is the CLI's (`id` a non-empty string and `role === 'user'`): a 2xx
 *   JSON without `role`, with another `role`, or with a bad `id` rejects as unknown.
 * - r2 T6: the error on D2–D4 is `ApiError('Unexpected send answer', <the 2xx>, { sendOutcome:
 *   'unknown' }, 'http')` — not the outer catch's status-0 wrap of a raw `SyntaxError` — and a
 *   ChatMessage served as `text/plain` is rejected by the content-type guard (as the CLI reads it).
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, worktreeApi } from '@/lib/api-client';
import { isSendOutcomeUnknown } from '@/hooks/usePendingMessages';
import { classifySendAnswer } from '@/lib/send-outcome/classify-send-answer';

const JSON_TYPE = 'application/json; charset=utf-8';

interface Answer {
  id: string;
  status: number;
  contentType: string;
  body: string;
}

/** D2–D4 of design §2.2: the 2xx that are not a ChatMessage. */
const NOT_A_MESSAGE: Answer[] = [
  { id: 'D2', status: 200, contentType: 'text/html; charset=utf-8', body: '<html>proxy</html>' },
  { id: 'D3', status: 200, contentType: JSON_TYPE, body: '' },
  { id: 'D4', status: 200, contentType: JSON_TYPE, body: '{}' },
];

function stubFetch(answer: Answer): void {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(answer.body.length > 0 ? answer.body : null, {
    status: answer.status,
    headers: { 'content-type': answer.contentType },
  })));
}

/** What a call resolved to, or what it threw. */
async function outcome(call: () => Promise<unknown>): Promise<{ resolved: unknown } | { thrown: unknown }> {
  try {
    return { resolved: await call() };
  } catch (thrown) {
    return { thrown };
  }
}

/** Callers of `fetchApi` that are not the send (a list read, a single read, a write). */
const OTHER_CALLERS: Array<[string, () => Promise<unknown>]> = [
  ['getMessages', () => worktreeApi.getMessages('wt-1', 'claude')],
  ['getById', () => worktreeApi.getById('wt-1')],
  ['markAsViewed (PATCH)', () => worktreeApi.markAsViewed('wt-1')],
];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#4603 INV-Q2] callers other than the send read a 2xx as before', () => {
  describe.each(OTHER_CALLERS)('%s', (_name, call) => {
    it('D2 non-JSON 2xx: ApiError "Unexpected response format" with the 2xx status, no data', async () => {
      stubFetch(NOT_A_MESSAGE[0]);
      const result = await outcome(call);
      expect('thrown' in result).toBe(true);
      const error = (result as { thrown: unknown }).thrown;
      expect(error).toBeInstanceOf(ApiError);
      expect(error).toMatchObject({ message: 'Unexpected response format', status: 200, kind: 'http' });
      expect((error as ApiError).data).toBeUndefined();
      expect(isSendOutcomeUnknown(error)).toBe(false);
    });

    it('D3 empty application/json 2xx: the raw SyntaxError of response.json()', async () => {
      stubFetch(NOT_A_MESSAGE[1]);
      const result = await outcome(call);
      expect('thrown' in result).toBe(true);
      const error = (result as { thrown: unknown }).thrown;
      expect(error).toBeInstanceOf(SyntaxError);
      expect(error).not.toBeInstanceOf(ApiError);
    });

    it('D4 `{}` 2xx: resolves to `{}`', async () => {
      stubFetch(NOT_A_MESSAGE[2]);
      expect(await outcome(call)).toEqual({ resolved: {} });
    });
  });
});

describe('[#4603 T4] the send still resolves on the 2xx the CLI reads as sent', () => {
  const timestamp = '2026-11-27T00:00:00.000Z';
  const row = { id: 'srv-1', worktreeId: 'wt-1', role: 'user', content: 'hello', timestamp };

  it.each([
    ['S1 201 ChatMessage', row],
    ['S2 201 ChatMessage with sendOutcome unknown (the relay could not place it)', { ...row, sendOutcome: 'unknown' }],
    ['S1 201 ChatMessage with a brief report', { ...row, brief: { injected: true } }],
  ])('%s: resolves to the row, its timestamp revived', async (_name, body) => {
    stubFetch({ id: 'S1', status: 201, contentType: JSON_TYPE, body: JSON.stringify(body) });
    const created = await worktreeApi.sendMessage('wt-1', 'hello', { cliToolId: 'claude' });
    expect(created).toEqual({ ...body, timestamp: new Date(timestamp) });
    expect(created.timestamp).toBeInstanceOf(Date);
  });
});

/** What the send threw (fails the test when it resolved). */
async function sendError(answer: Answer): Promise<unknown> {
  stubFetch(answer);
  const result = await outcome(() => worktreeApi.sendMessage('wt-1', 'hello', { cliToolId: 'claude' }));
  expect('thrown' in result, 'the send rejects on this answer').toBe(true);
  return (result as { thrown: unknown }).thrown;
}

describe('[#4603 r2 T5] the send rejects on a 2xx JSON that is not the CLI\'s ChatMessage (id and role)', () => {
  const timestamp = '2026-11-27T00:00:00.000Z';
  it.each<[string, unknown]>([
    ['{ id } only (no role)', { id: 'm' }],
    ['role missing, with the rest of a row', { id: 'm', worktreeId: 'wt-1', content: 'hello', timestamp }],
    ["role: 'assistant'", { id: 'm', role: 'assistant', content: 'hello', timestamp }],
    ["id: ''", { id: '', role: 'user', content: 'hello', timestamp }],
    ['id that is a number', { id: 1, role: 'user', content: 'hello', timestamp }],
    ['an array', [{ id: 'm', role: 'user' }]],
    ['null', null],
  ])('%s: ApiError, read as unknown', async (_name, body) => {
    const error = await sendError({ id: 'S4', status: 201, contentType: JSON_TYPE, body: JSON.stringify(body) });
    expect(error).toBeInstanceOf(ApiError);
    expect(isSendOutcomeUnknown(error)).toBe(true);
    expect(error).toMatchObject({ status: 201, data: { sendOutcome: 'unknown' } });
  });
});

describe('[#4603 r2 T6] the error the send throws on D2–D4 keeps the 2xx status and says unknown', () => {
  it.each([
    ['D2 non-JSON 2xx', { id: 'D2', status: 201, contentType: 'text/plain', body: 'created' }],
    ['D2 HTML 200', NOT_A_MESSAGE[0]],
    ['D3 empty application/json 2xx', { id: 'D3', status: 201, contentType: JSON_TYPE, body: '' }],
    ['D3 application/json that does not parse', { id: 'D3', status: 201, contentType: JSON_TYPE, body: '{"id":' }],
    ['D4 {}', { id: 'D4', status: 201, contentType: JSON_TYPE, body: '{}' }],
    // A ChatMessage that parses, served as another type: only the content-type guard rejects it.
    ['D2 a ChatMessage served as text/plain', {
      id: 'D2', status: 201, contentType: 'text/plain', body: JSON.stringify({ id: 'm', role: 'user', content: 'hello' }),
    }],
  ] as Array<[string, Answer]>)('%s: ApiError(Unexpected send answer, <its 2xx>, { sendOutcome: unknown }, http)', async (_name, answer) => {
    const error = await sendError(answer);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ message: 'Unexpected send answer', status: answer.status, kind: 'http' });
    expect((error as ApiError).data).toEqual({ sendOutcome: 'unknown' });
    expect(isSendOutcomeUnknown(error)).toBe(true);
    // The CLI reads the same answer as unknown too (design §2.2 S4).
    expect(classifySendAnswer({
      kind: 'response', status: answer.status, contentType: answer.contentType, bodyText: answer.body,
    }).fact).toBe('unknown');
  });
});
