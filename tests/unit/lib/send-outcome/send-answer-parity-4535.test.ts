/**
 * Issue #4535 (INV-S3, design `send-outcome-4535.md` §2.2): the CLI and the screen read one answer
 * of `POST /api/worktrees/:id/send` to the same fact.
 *
 * - CLI: `classifySendAnswer` (`src/lib/send-outcome/classify-send-answer.ts`), wired by
 *   `postMessage` in PR-B — fed the answer as it came off the wire (status, `content-type`, body).
 * - Screen: `isSendOutcomeUnknown` (`src/hooks/usePendingMessages.ts`) — fed the `ApiError` that the
 *   screen's own `worktreeApi.sendMessage` (`fetchApi`) builds from that same answer, with `fetch`
 *   stubbed to return it. So the screen's half also covers how `fetchApi` turns the wire into
 *   `kind` / `status` / `data`.
 *
 * The screen has two answers to the question, not three: `isSendOutcomeUnknown` true ⇔ the CLI's
 * `unknown`, false ⇔ the CLI's `not_sent` (every row below is a failed send; a `sent` from the CLI
 * on one of them is a disagreement too).
 *
 * Rows of §2.2 left out of the table, and why:
 * - S1 / S2 / S3 (2xx with a ChatMessage or an `ask`): the screen resolves on them, so there is no
 *   rejection for `isSendOutcomeUnknown` to read (sent on both sides). S4's 2xx are in the table
 *   where the screen rejects with an `ApiError` (the `/login` page), the rest are divergent rows.
 * - N8 and the `ask.sendState` half of U1: the screen never sends an `ask` (only the CLI's `ask`
 *   does), so its answers never carry one.
 * - N7 (a refused connection: `ApiError.cause` → `fetch failed` → `ECONNREFUSED`): a browser's
 *   `fetch` does not expose the socket's `code`, so the screen cannot see it. Its one counterpart —
 *   the screen's `kind: 'offline'` (refused before it was sent), `not_sent` on both sides — is one
 *   row of the transport table below.
 * - U2's redirect (a 3xx from a front proxy): both `fetch`es follow it and read the final answer,
 *   which is one of the other rows (the `/login` page after the auth redirect is one).
 *
 * Rows that disagree today are listed as `it.todo` at the end and are not asserted either way:
 * which side is right goes back to the human (PM's r4 ruling). Neither reader was changed.
 *
 * @vitest-environment node
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { classifySendAnswer, type SendFact } from '@/lib/send-outcome/classify-send-answer';
import { isSendOutcomeUnknown } from '@/hooks/usePendingMessages';
import { ApiError, worktreeApi } from '@/lib/api-client';

const JSON_TYPE = 'application/json; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

/** One answer of `/send`, as it comes off the wire. */
interface WireAnswer {
  /** The row of design §2.2 it falls into. */
  row: string;
  name: string;
  status: number;
  contentType: string | null;
  body: string;
  /** `fetch` followed the auth middleware's 307 to `/login` (the screen's `detectAuthRedirect`). */
  redirectedToLogin?: boolean;
}

function json(row: string, name: string, status: number, body: unknown): WireAnswer {
  return { row, name, status, contentType: JSON_TYPE, body: JSON.stringify(body) };
}

function page(row: string, name: string, status: number, contentType: string | null, body: string): WireAnswer {
  return { row, name, status, contentType, body };
}

/** Every failed answer the screen can receive, by design §2.2 (the route's shapes after PR-A2). */
const WIRE_ROWS: WireAnswer[] = [
  // N1–N3: the route's typed refusals before anything was typed.
  json('N1', '400 sendOutcome not_sent', 400, { error: 'model refused', code: 'model_refused', sendOutcome: 'not_sent' }),
  json('N1', '404 sendOutcome not_sent (no code)', 404, { error: 'Worktree not found', sendOutcome: 'not_sent' }),
  json('N1', '503 sendOutcome not_sent', 503, { error: 'x', code: 'SESSION_START_FAILED', sendOutcome: 'not_sent' }),
  json('N2', '409 SEND_TARGET_CHANGED not_sent', 409, {
    error: 'target changed', code: 'SEND_TARGET_CHANGED', reason: 'target-gone', sendOutcome: 'not_sent',
  }),
  json('N3', '409 TOOL_POLICY_DENIED not_sent', 409, { error: 'denied', code: 'TOOL_POLICY_DENIED', sendOutcome: 'not_sent' }),
  // N4: another copy reserved the relay — unknown, with or without the A2 `sendOutcome`.
  json('N4', '409 RELAY_BIND_CONFLICT sendOutcome unknown (after A2)', 409, {
    error: 'relay reserved', code: 'RELAY_BIND_CONFLICT', sendOutcome: 'unknown',
  }),
  json('N4', '409 RELAY_BIND_CONFLICT without sendOutcome', 409, { error: 'relay reserved', code: 'RELAY_BIND_CONFLICT' }),
  // N6: the middleware's typed refusals before any route (C12).
  json('N6', '401 AUTH_REQUIRED', 401, { error: 'Unauthorized', code: 'AUTH_REQUIRED' }),
  json('N6', '403 IP_DENIED', 403, { error: 'Forbidden', code: 'IP_DENIED' }),
  // U1: a failed answer that says the text may be in.
  json('U1', '500 sendOutcome unknown', 500, { error: 'x', sendOutcome: 'unknown' }),
  json('U1', '500 sendOutcome sent (a failed answer that typed)', 500, { error: 'x', sendOutcome: 'sent' }),
  json('U1', '409 sendOutcome unknown (the fence, #4534)', 409, { error: 'x', code: 'SEND_TARGET_CHANGED', sendOutcome: 'unknown' }),
  // U2: anything else that is not a 2xx.
  page('U2', '502 bare HTML page (a proxy)', 502, HTML_TYPE, '<html>Bad Gateway</html>'),
  page('U2', '504 bare text page (a tunnel)', 504, 'text/plain', 'Gateway Timeout'),
  page('U2', '404 bare HTML page', 404, HTML_TYPE, '<html>Not Found</html>'),
  page('U2', '408 bare HTML page', 408, HTML_TYPE, '<html>Request Timeout</html>'),
  page('U2', '405 empty body, no content-type', 405, null, ''),
  page('U2', '400 not_sent JSON served as text/plain', 400, 'text/plain', JSON.stringify({ sendOutcome: 'not_sent' })),
  page('U2', '401 AUTH_REQUIRED served as HTML', 401, HTML_TYPE, '<html>AUTH_REQUIRED</html>'),
  json('U2', '400 JSON without code ({ error } only)', 400, { error: 'bad request' }),
  json('U2', '409 JSON with an unknown code', 409, { error: 'x', code: 'SOMETHING_ELSE' }),
  json('U2', '500 JSON without sendOutcome', 500, { error: 'Internal Server Error' }),
  json('U2', '502 JSON without sendOutcome', 502, { error: 'bad gateway' }),
  json('U2', '400 sendOutcome that is not one of the three', 400, { error: 'x', sendOutcome: 'maybe' }),
  json('U2', '500 sendOutcome that is not one of the three', 500, { error: 'x', sendOutcome: 'maybe' }),
  json('U2', '500 AUTH_REQUIRED on the wrong status', 500, { error: 'x', code: 'AUTH_REQUIRED' }),
  // U2: the session start's 503s without sendOutcome (human decision on C10: unknown on both sides).
  json('U2', '503 SESSION_STARTING without sendOutcome', 503, { error: 'starting', code: 'SESSION_STARTING' }),
  json('U2', '503 SESSION_START_FAILED without sendOutcome', 503, { error: 'failed', code: 'SESSION_START_FAILED' }),
  json('U2', '503 SESSION_START_UNAVAILABLE without sendOutcome', 503, { error: 'unavailable', code: 'SESSION_START_UNAVAILABLE' }),
  // The auth middleware's 307 to /login, followed: the CLI reads the 200 page (S4), the screen its 401.
  { ...page('S4', '200 /login page after the auth redirect', 200, HTML_TYPE, '<html>login</html>'), redirectedToLogin: true },
];

/** A failure with no answer: what the CLI's request threw, and the `ApiError` the screen's threw. */
interface TransportRow {
  row: string;
  name: string;
  cliError: unknown;
  screenError: ApiError;
}

/** The socket error `fetch` wraps, wrapped again by the CLI's api-client. */
function cliTransportError(code: string): Error {
  const socket = Object.assign(new Error(`connect ${code} 127.0.0.1:1`), { code });
  return new Error('request failed', { cause: new TypeError('fetch failed', { cause: socket }) });
}

const TRANSPORT_ROWS: TransportRow[] = [
  {
    row: 'N7',
    name: 'refused before it was sent (CLI ECONNREFUSED ↔ screen offline)',
    cliError: cliTransportError('ECONNREFUSED'),
    screenError: new ApiError('No network connection', 0, undefined, 'offline'),
  },
  {
    row: 'U3',
    name: 'connection dropped (CLI ECONNRESET ↔ screen network)',
    cliError: cliTransportError('ECONNRESET'),
    screenError: new ApiError('Failed to fetch', 0, new TypeError('Failed to fetch'), 'network'),
  },
  {
    row: 'U3',
    name: 'timed out (CLI deadline ↔ screen timeout)',
    cliError: Object.assign(new Error('Request timed out after 30000ms'), { name: 'DeadlineExceededError' }),
    screenError: new ApiError('Request timed out after 30000ms', 0, undefined, 'timeout'),
  },
  {
    row: 'U3',
    name: 'aborted in flight (CLI AbortError ↔ screen aborted)',
    cliError: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    screenError: new ApiError('Request aborted', 0, undefined, 'aborted'),
  },
];

/** Rows of §2.2 the screen can receive on which the two readers disagree today (not asserted). */
const DIVERGENT_ROWS: WireAnswer[] = [
  // N5: the CLI reads an older server's pre-send codes as not_sent (Q2); the screen's C10 reads every
  // 4xx without `sendOutcome` (but 401/403 of C12) as unknown, and every 5xx without it too.
  json('N5', '409 PROMPT_WAITING without sendOutcome', 409, { error: 'x', code: 'PROMPT_WAITING' }),
  json('N5', '400 model_refused without sendOutcome', 400, { error: 'x', code: 'model_refused' }),
  json('N5', '409 ROLE_CONDITION_UNMET without sendOutcome', 409, { error: 'x', code: 'ROLE_CONDITION_UNMET' }),
  json('N5', '503 ROSTER_CHANGED without sendOutcome', 503, { error: 'x', code: 'ROSTER_CHANGED' }),
  // S4: a 2xx not served as JSON — the CLI says unknown; the screen's `detectNonJsonBody` throws an
  // `ApiError` with that 2xx status, which `isSendOutcomeUnknown` reads as not unknown.
  page('S4', '200 bare HTML page (not a redirect)', 200, HTML_TYPE, '<html>proxy</html>'),
  page('S4', '201 text/plain', 201, 'text/plain', 'created'),
  // S4: a JSON-typed 2xx with an empty body — `fetchApi` returns `response.json()` unawaited, so the
  // screen's send rejects with the raw `SyntaxError` (not an `ApiError`): not unknown.
  page('S4', '201 application/json with an empty body', 201, JSON_TYPE, ''),
  // S4: a JSON 2xx that is not a ChatMessage — the screen's send resolves on it (taken as sent).
  json('S4', '201 JSON that is not a ChatMessage ({})', 201, {}),
  // N6 on the wrong status: the CLI needs 401/403 to match the code; the screen reads the code alone.
  json('N6', '403 AUTH_REQUIRED (code on the other status)', 403, { error: 'x', code: 'AUTH_REQUIRED' }),
];

type ScreenRead = (error: unknown) => boolean;
type CliRead = (answer: WireAnswer) => SendFact;

const readCli: CliRead = (answer) =>
  classifySendAnswer({ kind: 'response', status: answer.status, contentType: answer.contentType, bodyText: answer.body }).fact;

/** The `Response` the stubbed `fetch` hands the screen's `fetchApi`. */
function toResponse(answer: WireAnswer): Response {
  const headers = answer.contentType === null ? undefined : { 'content-type': answer.contentType };
  // A null-body status cannot carry a body; none of the rows uses one.
  const response = new Response(answer.body.length > 0 ? answer.body : null, { status: answer.status, headers });
  if (answer.redirectedToLogin) {
    Object.defineProperty(response, 'redirected', { value: true });
    Object.defineProperty(response, 'url', { value: 'http://localhost/login?redirect=%2F' });
  }
  return response;
}

/** What the screen's own send rejects with for this answer (null when it resolved). */
async function screenErrorFor(answer: WireAnswer): Promise<unknown> {
  vi.stubGlobal('fetch', vi.fn(async () => toResponse(answer)));
  try {
    await worktreeApi.sendMessage('wt-1', 'hello', { cliToolId: 'claude' });
    return null;
  } catch (error) {
    return error;
  } finally {
    vi.unstubAllGlobals();
  }
}

/** The screen's fact for a failed send. */
function screenFact(read: ScreenRead, error: unknown): SendFact {
  return read(error) ? 'unknown' : 'not_sent';
}

interface Disagreement {
  name: string;
  cli: SendFact;
  screen: SendFact;
}

async function disagreements(cliRead: CliRead, screenRead: ScreenRead): Promise<Disagreement[]> {
  const found: Disagreement[] = [];
  for (const answer of WIRE_ROWS) {
    const error = await screenErrorFor(answer);
    const cli = cliRead(answer);
    // A send the screen took as done while the CLI did not is a disagreement too.
    const screen: SendFact = error === null ? 'sent' : screenFact(screenRead, error);
    if (cli !== screen) found.push({ name: `${answer.row} ${answer.name}`, cli, screen });
  }
  for (const transport of TRANSPORT_ROWS) {
    const cli = classifySendAnswer({ kind: 'error', error: transport.cliError }).fact;
    const screen = screenFact(screenRead, transport.screenError);
    if (cli !== screen) found.push({ name: `${transport.row} ${transport.name}`, cli, screen });
  }
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('[#4535 INV-S3] the CLI and the screen read one /send answer to the same fact', () => {
  it.each(WIRE_ROWS.map((answer) => [`${answer.row} ${answer.name}`, answer] as const))(
    '%s',
    async (_name, answer) => {
      const error = await screenErrorFor(answer);
      expect(error, 'the screen rejects on this answer').toBeInstanceOf(ApiError);
      expect(screenFact(isSendOutcomeUnknown, error)).toBe(readCli(answer));
    }
  );

  it.each(TRANSPORT_ROWS.map((row) => [`${row.row} ${row.name}`, row] as const))('%s', (_name, row) => {
    expect(screenFact(isSendOutcomeUnknown, row.screenError)).toBe(
      classifySendAnswer({ kind: 'error', error: row.cliError }).fact
    );
  });

  it('the table has both facts on both sides (a reader stuck on one answer would not pass)', async () => {
    const facts = new Set(WIRE_ROWS.map(readCli));
    expect(facts).toEqual(new Set<SendFact>(['unknown', 'not_sent']));
    expect(await disagreements(readCli, isSendOutcomeUnknown)).toEqual([]);
  });

  it('positive control: the screen back on "a 4xx without sendOutcome is not unknown" disagrees', async () => {
    const before4535: ScreenRead = (error) => {
      const e = error as { kind?: unknown; status?: unknown; data?: { sendOutcome?: unknown } };
      if (e.kind === 'http' && typeof e.status === 'number' && e.status >= 400 && e.status < 500
        && e.data?.sendOutcome === undefined) {
        return false;
      }
      return isSendOutcomeUnknown(error);
    };
    const found = await disagreements(readCli, before4535);
    expect(found.map((d) => d.name)).toEqual(expect.arrayContaining([
      'N4 409 RELAY_BIND_CONFLICT without sendOutcome',
      'U2 404 bare HTML page',
      'U2 400 JSON without code ({ error } only)',
    ]));
  });

  it('positive control: the CLI back on "a 5xx without sendOutcome is not_sent" disagrees', async () => {
    const mutatedCli: CliRead = (answer) => {
      const fact = readCli(answer);
      return answer.status >= 500 && !answer.body.includes('sendOutcome') ? 'not_sent' : fact;
    };
    const found = await disagreements(mutatedCli, isSendOutcomeUnknown);
    expect(found.map((d) => d.name)).toEqual(expect.arrayContaining([
      'U2 502 bare HTML page (a proxy)',
      'U2 503 SESSION_STARTING without sendOutcome',
    ]));
  });

  it('positive control: the screen back on "offline is unknown" disagrees on the N7 row', async () => {
    const offlineUnknown: ScreenRead = (error) =>
      (error as { kind?: unknown }).kind === 'offline' ? true : isSendOutcomeUnknown(error);
    const found = await disagreements(readCli, offlineUnknown);
    expect(found).toEqual([
      { name: 'N7 refused before it was sent (CLI ECONNREFUSED ↔ screen offline)', cli: 'not_sent', screen: 'unknown' },
    ]);
  });
});

describe('[#4535 INV-S3] rows that disagree today — which side is right is the human\'s call', () => {
  for (const answer of DIVERGENT_ROWS) {
    it.todo(`${answer.row} ${answer.name}`);
  }
});
