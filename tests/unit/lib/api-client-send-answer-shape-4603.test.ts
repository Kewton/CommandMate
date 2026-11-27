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
 * - r3 INV-Q1': the send's 2xx, row by row over the branches of the CLI's `classifySendAnswer`
 *   (body not an object — type, empty, parse, array, null; ChatMessage with each `sendOutcome`; with
 *   an `ask`; `ask` only) and the CLI's media-type rule (`isJsonType`): the screen's fact equals the
 *   CLI's, and every rejection is exactly `ApiError('Unexpected send answer', <the 2xx>,
 *   { sendOutcome: 'unknown' }, 'http')`. Rows where they differ are named (D6, #4632), not left out.
 * - r3 INV-Q3': through `sendMessage`, the non-2xx, the `/login` redirect, a body cut or stalled after
 *   the 201's headers, and a rejected `fetch` throw the ApiError they threw before #4603 (99105344b),
 *   written out literally — not a hand-made ApiError fed to a reader.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, worktreeApi } from '@/lib/api-client';
import { isSendOutcomeUnknown } from '@/hooks/usePendingMessages';
import { classifySendAnswer, type SendAnswerRow, type SendFact } from '@/lib/send-outcome/classify-send-answer';
import { getSendTimeoutMs } from '@/config/api-timeout-config';

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
    expect(error).toMatchObject({ message: 'Unexpected send answer', kind: 'http' });
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

// ---------------------------------------------------------------------------
// r3 (#4603): compared by the shape of what the send gives, not by one bit of its reader.
// ---------------------------------------------------------------------------

const enc = new TextEncoder();
const ROW_TS = '2026-11-27T00:00:00.000Z';
const MSG = { id: 'm', role: 'user', content: 'x', timestamp: ROW_TS };

interface Wire {
  status: number;
  contentType: string | null;
  body: string;
  redirectedToLogin?: boolean;
}

function wire(status: number, contentType: string | null, body: unknown, extra?: Partial<Wire>): Wire {
  return { status, contentType, body: typeof body === 'string' ? body : JSON.stringify(body), ...extra };
}

/** The `Response` a stubbed `fetch` hands the send: no content-type → bytes (so none is implied). */
function toWireResponse(answer: Wire): Response {
  const headers = answer.contentType === null ? undefined : { 'content-type': answer.contentType };
  const body = answer.body.length === 0 ? null : answer.contentType === null ? enc.encode(answer.body) : answer.body;
  const response = new Response(body, { status: answer.status, headers });
  if (answer.redirectedToLogin) {
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login?redirect=%2F' });
  }
  return response;
}

interface Shape {
  name: unknown;
  message: unknown;
  status: unknown;
  kind: unknown;
  data: unknown;
}

function shapeOf(error: unknown): Shape {
  const e = error as Partial<Shape>;
  return { name: e?.name, message: e?.message, status: e?.status, kind: e?.kind, data: e?.data };
}

type ScreenRead = { fact: 'sent'; id: unknown } | { fact: SendFact; error: unknown };

async function screenRead(response: () => Response | Promise<Response>): Promise<ScreenRead> {
  vi.stubGlobal('fetch', vi.fn(async () => response()));
  try {
    const created = await worktreeApi.sendMessage('wt-1', 'x', { cliToolId: 'claude' });
    return { fact: 'sent', id: (created as { id?: unknown }).id };
  } catch (error) {
    return { fact: isSendOutcomeUnknown(error) ? 'unknown' : 'not_sent', error };
  }
}

/** A row on which the two readers are meant to (D6) or known to (#4632) differ. */
type Mark = { intended: string } | { todo: string };

interface Q1Row {
  name: string;
  answer: Wire;
  /** The CLI's reading (pinned, so a change on that side shows up here too). */
  cli: SendFact;
  cliRow: SendAnswerRow;
  /** The screen's, only on a marked row (otherwise it is `cli`). */
  screen?: 'sent' | 'unknown';
  mark?: Mark;
}

const J = JSON_TYPE;
const ISSUE_4632 = 'https://github.com/Kewton/CommandMate/issues/4632';

const Q1_ROWS: Q1Row[] = [
  // ChatMessage, by `sendOutcome`
  { name: 'S1 ChatMessage', answer: wire(201, J, MSG), cli: 'sent', cliRow: 'S1' },
  { name: "S1 ChatMessage, sendOutcome 'sent'", answer: wire(201, J, { ...MSG, sendOutcome: 'sent' }), cli: 'sent', cliRow: 'S1' },
  { name: "S2 ChatMessage, sendOutcome 'unknown'", answer: wire(201, J, { ...MSG, sendOutcome: 'unknown' }), cli: 'sent', cliRow: 'S2' },
  {
    name: "ChatMessage, sendOutcome 'not_sent'", answer: wire(201, J, { ...MSG, sendOutcome: 'not_sent' }),
    cli: 'unknown', cliRow: 'S4', screen: 'sent', mark: { todo: ISSUE_4632 },
  },
  {
    name: 'ChatMessage, sendOutcome not one of the three', answer: wire(201, J, { ...MSG, sendOutcome: 'maybe' }),
    cli: 'unknown', cliRow: 'S4', screen: 'sent', mark: { todo: ISSUE_4632 },
  },
  // ChatMessage with an `ask`
  { name: "ChatMessage + ask.sendState 'sent'", answer: wire(201, J, { ...MSG, ask: { sendState: 'sent' } }), cli: 'sent', cliRow: 'S1' },
  {
    name: "ChatMessage + ask.sendState 'not_sent'", answer: wire(201, J, { ...MSG, ask: { sendState: 'not_sent' } }),
    cli: 'unknown', cliRow: 'S1', screen: 'sent', mark: { todo: `${ISSUE_4632} (from before #4603; the screen never sends an ask)` },
  },
  {
    name: "ChatMessage + ask.sendState 'send_unknown'", answer: wire(201, J, { ...MSG, ask: { sendState: 'send_unknown' } }),
    cli: 'unknown', cliRow: 'S1', screen: 'sent', mark: { todo: `${ISSUE_4632} (from before #4603; the screen never sends an ask)` },
  },
  // `ask` only
  {
    name: "S3 ask only, sendState 'sent'", answer: wire(201, J, { ask: { sendState: 'sent' } }),
    cli: 'sent', cliRow: 'S3', screen: 'unknown',
    mark: { intended: 'D6: the screen resolves on a ChatMessage only (human decision a); the screen never sends an ask' },
  },
  { name: "S3 ask only, sendState 'not_sent'", answer: wire(201, J, { ask: { sendState: 'not_sent' } }), cli: 'not_sent', cliRow: 'S3', screen: 'unknown',
    mark: { intended: 'D6: the screen resolves on a ChatMessage only; unknown is the safer side of not_sent' } },
  // Not a ChatMessage (S4): not JSON, empty, does not parse, another shape
  { name: 'D2 HTML 200', answer: wire(200, 'text/html; charset=utf-8', '<html>proxy</html>'), cli: 'unknown', cliRow: 'S4' },
  { name: 'D2 text/plain 201', answer: wire(201, 'text/plain', 'created'), cli: 'unknown', cliRow: 'S4' },
  { name: 'D2 a ChatMessage served as text/plain', answer: wire(201, 'text/plain', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'D3 empty application/json', answer: wire(201, J, ''), cli: 'unknown', cliRow: 'S4' },
  { name: 'D3 application/json that does not parse', answer: wire(201, J, '{"id":'), cli: 'unknown', cliRow: 'S4' },
  { name: 'D4 {}', answer: wire(201, J, {}), cli: 'unknown', cliRow: 'S4' },
  { name: '{ id } only', answer: wire(201, J, { id: 'm' }), cli: 'unknown', cliRow: 'S4' },
  { name: "role 'assistant'", answer: wire(201, J, { ...MSG, role: 'assistant' }), cli: 'unknown', cliRow: 'S4' },
  { name: "id ''", answer: wire(201, J, { ...MSG, id: '' }), cli: 'unknown', cliRow: 'S4' },
  { name: 'an array of ChatMessages', answer: wire(201, J, [MSG]), cli: 'unknown', cliRow: 'S4' },
  { name: 'null', answer: wire(201, J, null), cli: 'unknown', cliRow: 'S4' },
  { name: '204 with no body', answer: wire(204, null, ''), cli: 'unknown', cliRow: 'S4' },
  // The CLI's media-type rule (`isJsonType`), each with a ChatMessage body
  { name: 'CT none', answer: wire(201, null, MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT text/plain; profile="application/json"', answer: wire(201, 'text/plain; profile="application/json"', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/json-seq', answer: wire(201, 'application/json-seq', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/jsonx', answer: wire(201, 'application/jsonx', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/problem+json', answer: wire(201, 'application/problem+json', MSG), cli: 'sent', cliRow: 'S1' },
  { name: 'CT APPLICATION/JSON', answer: wire(201, 'APPLICATION/JSON', MSG), cli: 'sent', cliRow: 'S1' },
  { name: 'CT " application/json ;charset=utf-8"', answer: wire(201, ' application/json ;charset=utf-8', MSG), cli: 'sent', cliRow: 'S1' },
];

function expectedScreen(row: Q1Row): 'sent' | 'unknown' {
  if (row.mark) return row.screen!;
  // An unmarked row reads as the CLI; the screen has no `not_sent` for a 2xx.
  return row.cli === 'sent' ? 'sent' : 'unknown';
}

describe("[#4603 INV-Q1'] the send's 2xx table: each row as the CLI reads it, or a named difference", () => {
  it.each(Q1_ROWS.map((row) => [`${row.name}${row.mark ? ` [${'intended' in row.mark ? row.mark.intended : `todo ${row.mark.todo}`}]` : ''}`, row] as const))(
    '%s',
    async (_name, row) => {
      const cli = classifySendAnswer({
        kind: 'response', status: row.answer.status, contentType: row.answer.contentType, bodyText: row.answer.body,
      });
      expect({ fact: cli.fact, row: cli.row }).toEqual({ fact: row.cli, row: row.cliRow });

      const screen = await screenRead(() => toWireResponse(row.answer));
      const expected = expectedScreen(row);
      expect(screen.fact).toBe(expected);
      if (screen.fact === 'sent') {
        expect((screen as { id: unknown }).id).toBe(MSG.id);
      } else {
        expect(shapeOf((screen as { error: unknown }).error)).toEqual({
          name: 'ApiError', message: 'Unexpected send answer', status: row.answer.status, kind: 'http', data: { sendOutcome: 'unknown' },
        });
      }
      if (!row.mark) {
        // Unmarked: the same fact on both sides.
        expect(screen.fact === 'sent' ? 'sent' : 'unknown').toBe(row.cli === 'sent' ? 'sent' : 'unknown');
      } else {
        expect(expected, 'a marked row is one where the readers differ').not.toBe(row.cli);
      }
    },
  );

  it('the table is whole: every row is unmarked or marked, and every 2xx row of the CLI is in it', () => {
    const marked = Q1_ROWS.filter((row) => row.mark !== undefined).length;
    const unmarked = Q1_ROWS.filter((row) => row.mark === undefined).length;
    expect(marked + unmarked).toBe(Q1_ROWS.length);
    expect(Q1_ROWS.filter((row) => row.mark !== undefined && 'intended' in row.mark).length).toBeGreaterThan(0);
    for (const cliRow of ['S1', 'S2', 'S3', 'S4'] as const) {
      expect(Q1_ROWS.some((row) => row.cliRow === cliRow), `CLI row ${cliRow}`).toBe(true);
    }
  });
});

describe("[#4603 INV-Q3'] the send's non-2xx, /login redirect and body-read failures throw the pre-#4603 ApiError", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  const nonSuccess: Array<[string, Wire, Omit<Shape, 'name'>]> = [
    ['N1 400 sendOutcome not_sent', wire(400, J, { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' }),
      { message: 'model refused', status: 400, kind: 'http', data: { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' } }],
    ['N4 409 RELAY_BIND_CONFLICT without sendOutcome', wire(409, J, { error: 'relay reserved', code: 'RELAY_BIND_CONFLICT' }),
      { message: 'relay reserved', status: 409, kind: 'http', data: { error: 'relay reserved', code: 'RELAY_BIND_CONFLICT' } }],
    ['U1 500 sendOutcome unknown', wire(500, J, { error: 'x', sendOutcome: 'unknown' }),
      { message: 'x', status: 500, kind: 'http', data: { error: 'x', sendOutcome: 'unknown' } }],
    ['U2 502 HTML page', wire(502, 'text/html; charset=utf-8', '<html>Bad Gateway</html>'),
      { message: 'HTTP error 502', status: 502, kind: 'http', data: {} }],
    ['N6 401 AUTH_REQUIRED', wire(401, J, { error: 'Unauthorized', code: 'AUTH_REQUIRED' }),
      { message: 'Unauthorized', status: 401, kind: 'http', data: { error: 'Unauthorized', code: 'AUTH_REQUIRED' } }],
    ['U2 405 no body, no content-type', wire(405, null, ''), { message: 'HTTP error 405', status: 405, kind: 'http', data: {} }],
    ['S4 the /login page after the auth redirect (200)', wire(200, 'text/html; charset=utf-8', '<html>login</html>', { redirectedToLogin: true }),
      { message: 'Authentication required', status: 401, kind: 'http', data: undefined }],
  ];

  it.each(nonSuccess)('%s', async (_name, answer, expected) => {
    const screen = await screenRead(() => toWireResponse(answer));
    expect(screen.fact).not.toBe('sent');
    expect(shapeOf((screen as { error: unknown }).error)).toEqual({ name: 'ApiError', ...expected });
  });

  it('the body cut after the 201 headers: ApiError("terminated", 0, <the TypeError>, network)', async () => {
    const screen = await screenRead(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('{"id":'));
        controller.error(new TypeError('terminated'));
      },
    }), { status: 201, headers: { 'content-type': J } }));
    const shape = shapeOf((screen as { error: unknown }).error);
    expect({ ...shape, data: undefined }).toEqual({ name: 'ApiError', message: 'terminated', status: 0, kind: 'network', data: undefined });
    expect(shape.data).toBeInstanceOf(TypeError);
    expect((shape.data as Error).message).toBe('terminated');
  });

  it('the body stalled after the 201 headers: ApiError("Request timed out after <send timeout>ms", 0, timeout)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const pending = screenRead(() => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(enc.encode('{"id":'));
      },
    }), { status: 201, headers: { 'content-type': J } }));
    await vi.advanceTimersByTimeAsync(getSendTimeoutMs() + 5000);
    const screen = await pending;
    expect(shapeOf((screen as { error: unknown }).error)).toEqual({
      name: 'ApiError', message: `Request timed out after ${getSendTimeoutMs()}ms`, status: 0, kind: 'timeout', data: undefined,
    });
  });

  it('fetch rejected before any answer: ApiError("Failed to fetch", 0, <the TypeError>, network)', async () => {
    const screen = await screenRead(() => {
      throw new TypeError('Failed to fetch');
    });
    const shape = shapeOf((screen as { error: unknown }).error);
    expect({ ...shape, data: undefined }).toEqual({ name: 'ApiError', message: 'Failed to fetch', status: 0, kind: 'network', data: undefined });
    expect(shape.data).toBeInstanceOf(TypeError);
    expect((shape.data as Error).message).toBe('Failed to fetch');
  });
});
