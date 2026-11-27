/**
 * Issue #4632: the hand-off dialog's text send reads a 2xx with the CLI's own table.
 *
 * - INV-H1: every 2xx row of `api-client-send-answer-shape-4603.test.ts`'s `Q1_ROWS` (29 rows) goes
 *   through `handoffApi.sendText`, compared by shape: a sent row is `{ ok: true, status, body }`
 *   (S1 / S2 only), every other 2xx is `{ ok: false, status, outcome: 'unknown' }`. The row count is
 *   fixed so a thinned table is red.
 * - INV-H2: the non-2xx, the `/login` redirect, a transport failure (including a body cut after the
 *   headers) and the gate's refusal are exactly what they were before this change (literal shapes).
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { handoffApi, HANDOFF_SCREEN_TIMEOUT_MS } from '@/lib/handoff/screen-client';
import { classifySendAnswer, type SendAnswerRow, type SendFact } from '@/lib/send-outcome/classify-send-answer';
import {
  HandoffPageOperationRefusedError,
  registerHandoffPage,
  reportHandoffPageAuth,
  resetHandoffRegistryForTests,
} from '@/lib/handoff/page-registration';

const JSON_TYPE = 'application/json; charset=utf-8';
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

/** The `Response` the stubbed `fetch` hands the send: no content-type → bytes (so none is implied). */
function toResponse(answer: Wire): Response {
  const headers = answer.contentType === null ? undefined : { 'content-type': answer.contentType };
  const body = answer.status === 204 || answer.body.length === 0
    ? null
    : answer.contentType === null ? enc.encode(answer.body) : answer.body;
  const response = new Response(body, { status: answer.status, headers });
  if (answer.redirectedToLogin) {
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login?redirect=%2F' });
  }
  return response;
}

interface Q1Row {
  name: string;
  answer: Wire;
  cli: SendFact;
  cliRow: SendAnswerRow;
  /** 追記 4: the 2xx body's read fails (immediately / at the deadline) — the CLI's U3. */
  read?: 'throw' | 'stall';
}

const J = JSON_TYPE;

/** The same 29 answers as `Q1_ROWS` (#4603 INV-Q1'). */
const ROWS: Q1Row[] = [
  { name: 'S1 ChatMessage', answer: wire(201, J, MSG), cli: 'sent', cliRow: 'S1' },
  { name: "S1 ChatMessage, sendOutcome 'sent'", answer: wire(201, J, { ...MSG, sendOutcome: 'sent' }), cli: 'sent', cliRow: 'S1' },
  { name: "S2 ChatMessage, sendOutcome 'unknown'", answer: wire(201, J, { ...MSG, sendOutcome: 'unknown' }), cli: 'sent', cliRow: 'S2' },
  { name: "ChatMessage, sendOutcome 'not_sent'", answer: wire(201, J, { ...MSG, sendOutcome: 'not_sent' }), cli: 'unknown', cliRow: 'S4' },
  { name: 'ChatMessage, sendOutcome not one of the three', answer: wire(201, J, { ...MSG, sendOutcome: 'maybe' }), cli: 'unknown', cliRow: 'S4' },
  { name: "ChatMessage + ask.sendState 'sent'", answer: wire(201, J, { ...MSG, ask: { sendState: 'sent' } }), cli: 'sent', cliRow: 'S1' },
  { name: "ChatMessage + ask.sendState 'not_sent'", answer: wire(201, J, { ...MSG, ask: { sendState: 'not_sent' } }), cli: 'unknown', cliRow: 'S1' },
  { name: "ChatMessage + ask.sendState 'send_unknown'", answer: wire(201, J, { ...MSG, ask: { sendState: 'send_unknown' } }), cli: 'unknown', cliRow: 'S1' },
  { name: "S3 ask only, sendState 'sent'", answer: wire(201, J, { ask: { sendState: 'sent' } }), cli: 'sent', cliRow: 'S3' },
  { name: "S3 ask only, sendState 'not_sent'", answer: wire(201, J, { ask: { sendState: 'not_sent' } }), cli: 'not_sent', cliRow: 'S3' },
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
  { name: 'CT none', answer: wire(201, null, MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT text/plain; profile="application/json"', answer: wire(201, 'text/plain; profile="application/json"', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/json-seq', answer: wire(201, 'application/json-seq', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/jsonx', answer: wire(201, 'application/jsonx', MSG), cli: 'unknown', cliRow: 'S4' },
  { name: 'CT application/problem+json', answer: wire(201, 'application/problem+json', MSG), cli: 'sent', cliRow: 'S1' },
  { name: 'CT APPLICATION/JSON', answer: wire(201, 'APPLICATION/JSON', MSG), cli: 'sent', cliRow: 'S1' },
  { name: 'CT " application/json ;charset=utf-8"', answer: wire(201, ' application/json ;charset=utf-8', MSG), cli: 'sent', cliRow: 'S1' },
  // 追記 4: the 2xx body's read fails — the CLI's U3 (unknown), never sent.
  { name: '2xx body read throws', answer: wire(201, J, MSG), cli: 'unknown', cliRow: 'U3', read: 'throw' },
  { name: '2xx body read stalls (the screen deadline)', answer: wire(201, J, MSG), cli: 'unknown', cliRow: 'U3', read: 'stall' },
];

/** The hand-off send's result for one answer (the fetch is stubbed for it). */
async function sendTextFor(answer: Wire): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(async () => toResponse(answer)));
  try {
    return await handoffApi.sendText('wt-1', 'hello', { cliToolId: 'claude', instanceId: 'claude' });
  } finally {
    vi.unstubAllGlobals();
  }
}

/** 追記 4: a 2xx whose body's read throws now, or stalls until the screen's deadline. */
async function sendTextForRow(row: Q1Row): Promise<unknown> {
  if (row.read === undefined) return sendTextFor(row.answer);
  if (row.read === 'stall') vi.useFakeTimers();
  vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => new Response(new ReadableStream({
    start(controller) {
      if (row.read === 'throw') controller.error(new TypeError('terminated'));
      else init?.signal?.addEventListener('abort', () => controller.error(new DOMException('aborted', 'AbortError')));
    },
  }), { status: row.answer.status, headers: { 'content-type': J } })));
  try {
    if (row.read === 'stall') {
      const pending = handoffApi.sendText('wt-1', 'hello', { cliToolId: 'claude', instanceId: 'claude' });
      await vi.advanceTimersByTimeAsync(HANDOFF_SCREEN_TIMEOUT_MS + 1000);
      return await pending;
    }
    return await handoffApi.sendText('wt-1', 'hello', { cliToolId: 'claude', instanceId: 'claude' });
  } finally {
    if (row.read === 'stall') vi.useRealTimers();
    vi.unstubAllGlobals();
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetHandoffRegistryForTests();
});

describe('[#4632 INV-H1] the hand-off text send reads each 2xx as the CLI does, by shape', () => {
  it.each(ROWS.map((row) => [row.name, row] as const))('%s', async (_name, row) => {
    // 追記 4: a body-read failure is the CLI's `kind: 'error'` (U3), not a response row.
    const cli = row.read === undefined
      ? classifySendAnswer({
        kind: 'response', status: row.answer.status, contentType: row.answer.contentType, bodyText: row.answer.body,
      })
      : classifySendAnswer({
        kind: 'error', error: row.read === 'throw' ? new TypeError('terminated') : new Error('Request timed out'),
      });
    expect({ fact: cli.fact, row: cli.row }).toEqual({ fact: row.cli, row: row.cliRow });

    const result = await sendTextForRow(row);
    if (cli.fact === 'sent' && (cli.row === 'S1' || cli.row === 'S2')) {
      expect(result).toEqual({ ok: true, status: row.answer.status, body: JSON.parse(row.answer.body) });
    } else {
      expect(result).toEqual({ ok: false, status: row.answer.status, outcome: 'unknown' });
    }
  });

  it('the table is whole: 31 rows (29 answers + the two body-read failures)', () => {
    expect(ROWS).toHaveLength(31);
  });
});

describe('[#4632 INV-H2] the non-2xx, the redirect, the transport failure and the refusal are unchanged', () => {
  it.each([
    ['N1 400 JSON', wire(400, J, { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' }),
      { ok: false, status: 400, code: 'model_refused', body: { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' } }],
    ['N4 409 JSON', wire(409, J, { error: 'relay reserved', code: 'RELAY_BIND_CONFLICT' }),
      { ok: false, status: 409, code: 'RELAY_BIND_CONFLICT', body: { error: 'relay reserved', code: 'RELAY_BIND_CONFLICT' } }],
    ['U1 500 JSON', wire(500, J, { error: 'x', sendOutcome: 'unknown' }),
      { ok: false, status: 500, body: { error: 'x', sendOutcome: 'unknown' } }],
    ['U2 502 HTML', wire(502, 'text/html; charset=utf-8', '<html>Bad Gateway</html>'),
      { ok: false, status: 502, body: {} }],
    ['N6 401 JSON', wire(401, J, { error: 'Unauthorized', code: 'AUTH_REQUIRED' }),
      { ok: false, status: 401, code: 'AUTH_REQUIRED', body: { error: 'Unauthorized', code: 'AUTH_REQUIRED' } }],
    ['U2 405 no body, no content-type', wire(405, null, ''),
      { ok: false, status: 405, body: {} }],
  ] as Array<[string, Wire, unknown]>)('%s: the same shape as before #4632', async (_name, answer, expected) => {
    expect(await sendTextFor(answer)).toEqual(expected);
  });

  it('the /login redirect (200 HTML) is the expiry, never a success', async () => {
    const result = await sendTextFor(wire(200, 'text/html; charset=utf-8', '<html>login</html>', { redirectedToLogin: true }));
    expect(result).toEqual({ ok: false, status: 401, expired: false });
  });

  it('a rejected fetch is { ok: false, status: 0 }', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }));
    const result = await handoffApi.sendText('wt-1', 'hello', { cliToolId: 'claude', instanceId: 'claude' });
    expect(result).toEqual({ ok: false, status: 0 });
  });

  it('the gate’s refusal is the refused error, with nothing sent', async () => {
    const owner = registerHandoffPage('wt-1');
    reportHandoffPageAuth(owner, 'expired', Number.MAX_SAFE_INTEGER - 1);
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const result = await handoffApi.sendText('wt-1', 'hello', { cliToolId: 'claude', instanceId: 'claude' }, owner);
    expect(result.ok).toBe(false);
    expect((result as { refused?: unknown }).refused).toBeInstanceOf(HandoffPageOperationRefusedError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
