/**
 * The send answer → sent / not_sent / unknown table (Issue #4535, design §2.2).
 *
 * One row per line of the table. The module is not wired anywhere yet (stage 1),
 * so these tests are the only thing that pins it; each `it` names the row and
 * the mutation it catches.
 *
 * @vitest-environment node
 */

import { describe, expect, it } from 'vitest';
import {
  classifySendAnswer,
  applyRelayLookup,
  isConnectionRefused,
  type SendAnswerInput,
} from '@/lib/send-outcome/classify-send-answer';

const JSON_TYPE = 'application/json; charset=utf-8';

function response(status: number, body: unknown, contentType: string | null = JSON_TYPE): SendAnswerInput {
  return {
    kind: 'response',
    status,
    contentType,
    bodyText: typeof body === 'string' ? body : JSON.stringify(body),
  };
}

const CHAT_MESSAGE = { id: '6f0c1c1e-0000-4000-8000-000000000001', worktreeId: 'wt', role: 'user', content: 'x' };

/** What `fetch` throws for a refused connection: TypeError('fetch failed') with the socket error as cause. */
function refused(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }) });
}

/** The CLI wraps that in its own error as `cause` (api-client.ts sendWithBody). */
function wrapped(error: unknown): Error {
  return new Error('Server is not running. Start it with: commandmate start', { cause: error });
}

describe('classifySendAnswer — success answers (S rows)', () => {
  it('S1: a 201 ChatMessage is sent', () => {
    expect(classifySendAnswer(response(201, CHAT_MESSAGE))).toMatchObject({ fact: 'sent', row: 'S1' });
  });

  it('S1: a ChatMessage that says sendOutcome sent is sent', () => {
    expect(classifySendAnswer(response(201, { ...CHAT_MESSAGE, sendOutcome: 'sent' }))).toMatchObject({ fact: 'sent', row: 'S1' });
  });

  it('S2: a ChatMessage with sendOutcome unknown is still sent (only the relay observation is unknown)', () => {
    expect(classifySendAnswer(response(201, { ...CHAT_MESSAGE, relayId: 'r', sendOutcome: 'unknown' }))).toMatchObject({
      fact: 'sent',
      row: 'S2',
      consultRelay: false,
    });
  });

  it.each([
    ['sent', 'sent'],
    ['not_sent', 'not_sent'],
    ['reserved', 'unknown'],
    ['send_unknown', 'unknown'],
    ['failed', 'unknown'], // the relay's word, not the ask's: never read as not_sent
  ] as const)('S3: the ask replay answer with sendState %s is %s', (sendState, fact) => {
    const answer = response(200, { ask: { id: 'a', state: 'pending', reason: null, sendState } });
    expect(classifySendAnswer(answer)).toMatchObject({ fact, row: 'S3' });
  });

  it.each([
    ['an empty 204', response(204, '', null)],
    ['an empty 200', response(200, '', JSON_TYPE)],
    ['a non-JSON 200', response(200, '<html>ok</html>', 'text/html')],
    ['JSON of another shape', response(200, { ok: true })],
    ['a ChatMessage sent with a text/html type', response(201, JSON.stringify(CHAT_MESSAGE), 'text/html')],
    ['a ChatMessage whose id is not a string', response(201, { ...CHAT_MESSAGE, id: 7 })],
    ['a ChatMessage of the assistant', response(201, { ...CHAT_MESSAGE, role: 'assistant' })],
    ['a JSON array', response(200, [CHAT_MESSAGE])],
  ])('S4: %s is unknown, and the relay is consulted', (_name, answer) => {
    expect(classifySendAnswer(answer)).toMatchObject({ fact: 'unknown', row: 'S4', consultRelay: true });
  });

  it('a ChatMessage whose ask says send_unknown is not called sent (the weaker one wins)', () => {
    const answer = response(201, { ...CHAT_MESSAGE, ask: { id: 'a', state: 'pending', reason: null, sendState: 'send_unknown' } });
    expect(classifySendAnswer(answer).fact).toBe('unknown');
  });
});

describe('classifySendAnswer — refusals with proof (N rows)', () => {
  it('N1: any refusal that says sendOutcome not_sent is not_sent', () => {
    expect(classifySendAnswer(response(409, { error: 'w', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' }))).toMatchObject({
      fact: 'not_sent',
      row: 'N1',
      relayOwned: true,
    });
    expect(classifySendAnswer(response(500, { error: 'x', sendOutcome: 'not_sent' }))).toMatchObject({ fact: 'not_sent', row: 'N1' });
  });

  it('N2: SEND_TARGET_CHANGED not_sent', () => {
    expect(classifySendAnswer(response(409, { error: 'x', code: 'SEND_TARGET_CHANGED', sendOutcome: 'not_sent' }))).toMatchObject({
      fact: 'not_sent',
      row: 'N2',
    });
  });

  it('N2 control: SEND_TARGET_CHANGED unknown is unknown (#4534)', () => {
    expect(classifySendAnswer(response(409, { error: 'x', code: 'SEND_TARGET_CHANGED', sendOutcome: 'unknown' }))).toMatchObject({
      fact: 'unknown',
      row: 'U1',
    });
  });

  it('N3: TOOL_POLICY_DENIED not_sent', () => {
    expect(classifySendAnswer(response(409, { error: 'x', code: 'TOOL_POLICY_DENIED', sendOutcome: 'not_sent' }))).toMatchObject({
      fact: 'not_sent',
      row: 'N3',
    });
  });

  it.each(['ASK_ID_CONFLICT', 'RELAY_BIND_INVALID', 'RELAY_BIND_FAILED', 'model_refused', 'INVALID_PATH', 'PROMPT_WAITING', 'session_owned_by_other_server', 'ROLE_CONDITION_UNMET', 'ROSTER_CHANGED'])(
    'N5: an older server\'s typed refusal %s without sendOutcome is not_sent, and the relay is ours',
    (code) => {
      expect(classifySendAnswer(response(400, { error: 'x', code }))).toMatchObject({ fact: 'not_sent', row: 'N5', relayOwned: true });
    },
  );

  it.each([
    [401, 'AUTH_REQUIRED'],
    [403, 'IP_DENIED'],
  ])('N6: middleware %i with code %s is not_sent', (status, code) => {
    expect(classifySendAnswer(response(status, { error: 'x', code }))).toMatchObject({ fact: 'not_sent', row: 'N6' });
  });

  it('N6 control: the same code on another status is not proof', () => {
    expect(classifySendAnswer(response(502, { error: 'x', code: 'AUTH_REQUIRED' }))).toMatchObject({ fact: 'unknown', row: 'U2' });
  });

  it('N7: a refused connection (fetch failed → ECONNREFUSED), wrapped by the CLI, is not_sent', () => {
    expect(classifySendAnswer({ kind: 'error', error: wrapped(refused()) })).toMatchObject({ fact: 'not_sent', row: 'N7', consultRelay: false });
  });

  it('N7: an AggregateError whose every error is ECONNREFUSED (IPv4 and IPv6) is not_sent', () => {
    const both = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:1'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED ::1:1'), { code: 'ECONNREFUSED' }),
    ]);
    expect(classifySendAnswer({ kind: 'error', error: wrapped(new TypeError('fetch failed', { cause: both })) })).toMatchObject({
      fact: 'not_sent',
      row: 'N7',
    });
  });

  it('N8: a refusal whose ask says not_sent is not_sent', () => {
    expect(classifySendAnswer(response(400, { error: 'x', ask: { id: 'a', state: 'unavailable', reason: null, sendState: 'not_sent' } }))).toMatchObject({
      fact: 'not_sent',
      row: 'N8',
    });
  });
});

describe('classifySendAnswer — RELAY_BIND_CONFLICT (N4) is decided by its code first', () => {
  it('N4: without sendOutcome it is unknown, the relay is not ours, and it is looked up', () => {
    expect(classifySendAnswer(response(409, { error: 'already bound', code: 'RELAY_BIND_CONFLICT' }))).toEqual({
      fact: 'unknown',
      row: 'N4',
      relayOwned: false,
      consultRelay: true,
    });
  });

  it('N4: with sendOutcome not_sent (a server that got it wrong) it is still unknown — the code goes first', () => {
    expect(classifySendAnswer(response(409, { error: 'x', code: 'RELAY_BIND_CONFLICT', sendOutcome: 'not_sent' }))).toMatchObject({
      fact: 'unknown',
      row: 'N4',
      relayOwned: false,
    });
  });

  it('N4: with sendOutcome unknown (design §2.4) it is N4, not U1 — the lookup still runs', () => {
    expect(classifySendAnswer(response(409, { error: 'x', code: 'RELAY_BIND_CONFLICT', sendOutcome: 'unknown' }))).toMatchObject({
      row: 'N4',
      consultRelay: true,
      relayOwned: false,
    });
  });
});

describe('classifySendAnswer — no proof (U rows)', () => {
  it.each(['unknown', 'sent'])('U1: a refusal that says sendOutcome %s is unknown', (sendOutcome) => {
    expect(classifySendAnswer(response(500, { error: 'x', sendOutcome }))).toMatchObject({ fact: 'unknown', row: 'U1', consultRelay: false });
  });

  it('U1: a refusal whose ask says send_unknown is unknown', () => {
    expect(classifySendAnswer(response(500, { error: 'x', ask: { id: 'a', state: 'pending', reason: null, sendState: 'send_unknown' } }))).toMatchObject({
      fact: 'unknown',
      row: 'U1',
    });
  });

  it('weaker wins: sendOutcome not_sent with ask send_unknown is unknown', () => {
    const answer = response(500, { error: 'x', sendOutcome: 'not_sent', ask: { id: 'a', state: 'pending', reason: null, sendState: 'send_unknown' } });
    expect(classifySendAnswer(answer).fact).toBe('unknown');
  });

  it.each([
    ['a bare 408 HTML page', response(408, '<html>Request Timeout</html>', 'text/html')],
    ['a 400 with no code ({ error } only)', response(400, { error: 'Bad request' })],
    ['a 401 with no code (a proxy, or the middleware before C12)', response(401, { error: 'Unauthorized' })],
    ['a 403 with no body', response(403, '', null)],
    ['a 404 HTML page', response(404, '<html>404</html>', 'text/html')],
    ['a 405', response(405, '', null)],
    ['a 302 a front returned', response(302, '', null)],
    ['a 413 with a JSON body that is not ours', response(413, { message: 'too large' })],
    ['a 502 from a tunnel', response(502, '<html>Bad gateway</html>', 'text/html')],
    ['an unknown code', response(409, { error: 'x', code: 'SOMETHING_NEW' })],
    ['a known code in a body served as text/html', response(400, JSON.stringify({ error: 'x', code: 'model_refused' }), 'text/html')],
    ['a sendOutcome that is not one of the three', response(500, { error: 'x', sendOutcome: 'maybe' })],
  ])('U2: %s is unknown, and the relay is consulted', (_name, answer) => {
    expect(classifySendAnswer(answer)).toMatchObject({ fact: 'unknown', row: 'U2', consultRelay: true });
  });

  it.each([
    ['a dropped connection (ECONNRESET after the request went out)', wrapped(new TypeError('fetch failed', { cause: Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }) }))],
    ['a timeout', wrapped(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }))],
    ['a JSON parse failure', wrapped(new SyntaxError('Unexpected token <'))],
    ['an AggregateError with one refusal and one reset', wrapped(new TypeError('fetch failed', {
      cause: new AggregateError([
        Object.assign(new Error('a'), { code: 'ECONNREFUSED' }),
        Object.assign(new Error('b'), { code: 'ECONNRESET' }),
      ]),
    }))],
    ['an empty AggregateError', wrapped(new TypeError('fetch failed', { cause: new AggregateError([]) }))],
    ['not an Error at all', 'boom'],
  ])('U3: %s is unknown', (_name, error) => {
    expect(classifySendAnswer({ kind: 'error', error })).toMatchObject({ fact: 'unknown', row: 'U3', consultRelay: true });
  });
});

describe('applyRelayLookup — the bound relay\'s sendState after an unknown answer', () => {
  const conflict = classifySendAnswer(response(409, { error: 'x', code: 'RELAY_BIND_CONFLICT' }));
  const dropped = classifySendAnswer({ kind: 'error', error: wrapped(new TypeError('fetch failed')) });

  it.each([
    ['sent', 'sent'],
    ['awaiting', 'unknown'],
    ['input_started', 'unknown'],
    ['unknown', 'unknown'],
    [null, 'unknown'],
  ] as const)('%s → %s, and N4 never becomes the relay\'s owner (Q13 default)', (sendState, fact) => {
    expect(applyRelayLookup(conflict, sendState)).toMatchObject({ fact, row: 'N4', relayOwned: false });
    expect(applyRelayLookup(dropped, sendState)).toMatchObject({ fact, relayOwned: true });
  });

  it('failed → not_sent, and N4 becomes the relay\'s owner again (Q13 (b): the one bound attempt typed nothing)', () => {
    expect(applyRelayLookup(conflict, 'failed')).toMatchObject({ fact: 'not_sent', row: 'N4', relayOwned: true });
    expect(applyRelayLookup(dropped, 'failed')).toMatchObject({ fact: 'not_sent', relayOwned: true });
  });

  it('a classification with proof is not overridden by the lookup', () => {
    const notSent = classifySendAnswer(response(409, { error: 'w', code: 'PROMPT_WAITING', sendOutcome: 'not_sent' }));
    expect(applyRelayLookup(notSent, 'sent')).toEqual(notSent);
  });
});

describe('isConnectionRefused', () => {
  it('follows at most a short cause chain and never loops on a cycle', () => {
    const a: Error & { cause?: unknown } = new Error('a');
    const b: Error & { cause?: unknown } = new Error('b', { cause: a });
    a.cause = b;
    expect(isConnectionRefused(a)).toBe(false);
  });

  it('a code on a plain object is read too', () => {
    expect(isConnectionRefused({ code: 'ECONNREFUSED' })).toBe(true);
    expect(isConnectionRefused(undefined)).toBe(false);
  });
});

/**
 * Review P2 (#4535 B): Node's own `AggregateError` (`autoSelectFamily`, IPv4 and IPv6
 * both tried) carries `code` copied from its first error. Measured on Node v24.1.0:
 * `AggregateError ECONNREFUSED [ 'ECONNREFUSED', 'ECONNREFUSED' ]`. So the shape here is
 * the real one — `code: 'ECONNREFUSED'` on top — and only its `errors` may decide.
 */
describe('isConnectionRefused — an AggregateError as Node makes it (code copied from errors[0])', () => {
  const nodeAggregate = (...codes: string[]): AggregateError =>
    Object.assign(
      new AggregateError(codes.map((code) => Object.assign(new Error(`connect ${code}`), { code }))),
      { code: codes[0] ?? 'ECONNREFUSED' }
    );
  const viaFetch = (cause: unknown): Error => wrapped(new TypeError('fetch failed', { cause }));

  it('N7: every error refused (the code on top too) is not_sent', () => {
    expect(classifySendAnswer({ kind: 'error', error: viaFetch(nodeAggregate('ECONNREFUSED', 'ECONNREFUSED')) })).toMatchObject({
      fact: 'not_sent',
      row: 'N7',
    });
  });

  it.each([
    ['a refusal, then a timeout', ['ECONNREFUSED', 'ETIMEDOUT']],
    ['a refusal, then an unreachable host', ['ECONNREFUSED', 'EHOSTUNREACH']],
    ['a refusal, then a reset', ['ECONNREFUSED', 'ECONNRESET']],
  ])('U3: %s is unknown although the code on top says ECONNREFUSED', (_name, codes) => {
    expect(classifySendAnswer({ kind: 'error', error: viaFetch(nodeAggregate(...codes)) })).toMatchObject({
      fact: 'unknown',
      row: 'U3',
    });
  });

  it('U3: no errors at all, with ECONNREFUSED on top, is unknown', () => {
    expect(isConnectionRefused(viaFetch(nodeAggregate()))).toBe(false);
  });
});
