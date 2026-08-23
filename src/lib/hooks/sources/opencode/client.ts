/**
 * Talking to one opencode server (Issue #1763).
 *
 * The server is not a separate process. #1758 §5.1.2 measured that the plain
 * `opencode` TUI *is* an HTTP server when it is given `--port`: `/global/health`,
 * `/event`, `GET /permission` and the reply endpoints all answered identically
 * to `opencode serve`. So there is no daemon to supervise here — the server's
 * lifetime is the pane's lifetime, and everything in this file is a request to
 * a port that either answers or does not.
 *
 * Five measurements shape the choices below.
 *
 *  - **The subscription is legacy `GET /event`.** `GET /api/event` (v2) goes
 *    silent after the first three frames of a turn, reproducibly, and
 *    `GET /api/session/:id/event?after=<seq>` returns zero bytes — so neither
 *    the newer envelope nor durable replay is usable on 1.18.3 (#1758 §5.2.2).
 *  - **The frames name their event in the JSON, not in the SSE `event:` field.**
 *    Every frame is a bare `data:` line, so a named `EventSource` listener picks
 *    up nothing. The parser below reads `data:` and nothing else.
 *  - **Replies go to `POST /permission/:requestID/reply`.** There are two
 *    endpoints and they differ (#1758 §5.5.2): the per-session one takes
 *    `{"response":…}` and cannot carry a reason, while this one takes
 *    `{"reply":…, "message"?:…}` and the message reaches the agent verbatim —
 *    it turned up in the tool part's `state.error`. One had to be picked and
 *    fixed; this is the superset, and a denial CommandMate cannot explain is a
 *    denial the agent cannot act on.
 *  - **Absence is free to detect.** A closed port fails in under a millisecond
 *    (§5.7.2), so health checks cost nothing and every call here is allowed to
 *    be attempted rather than guarded by cached state.
 *  - **An unknown route answers `200 text/html`.** Measured on 1.18.21 (Issue
 *    #1931): a path the server does not know gets the web UI's SPA shell, not a
 *    404. "The socket accepted me" is therefore not "the route exists", which is
 *    why every call below checks the media type as well as the status — and why
 *    redirects are refused rather than followed. See
 *    {@link OPENCODE_FETCH_REDIRECT}.
 *
 * Nothing in this module throws. A source that cannot reach its agent has to
 * degrade to the screen scraper, and an exception on the way to that decision
 * would take the caller down with it.
 *
 * @module lib/hooks/sources/opencode/client
 */

import { createLogger } from '@/lib/logger';

const logger = createLogger('lib/hooks/sources/opencode/client');

/**
 * The only host an opencode server is ever addressed on.
 *
 * `--hostname` defaults to this and the spike confirmed the LAN address refuses
 * connections (#1758 §5.8.3). The server is unauthenticated by default, so
 * binding it anywhere else would publish an arbitrary-command execution API to
 * the network; `--mdns`, which flips the default to `0.0.0.0`, is never passed.
 */
export const OPENCODE_SERVER_HOST = '127.0.0.1';

/** Timeout for the small request/response calls. Generous: they answer in ms. */
export const OPENCODE_REQUEST_TIMEOUT_MS = 5_000;

/**
 * Never follow a redirect off this port (Issue #1931, §10.4 / S13).
 *
 * The port is the whole of the trust model here: an opencode server is
 * unauthenticated, and `isPortFree` is a bind-and-close check, so any local
 * process can take the number CommandMate wrote down. `fetch` defaults to
 * `redirect: 'follow'`, which means a squatter answering `302 Location: …`
 * chooses where CommandMate's *server* sends its next request. Two consequences,
 * and the second is the worse one:
 *
 *  - It reads the identity, the pending approvals and the session activity off a
 *    host it never chose, and then adjudicates approvals against it.
 *  - Pointed back at CommandMate's own API, it is an SSRF that arrives from
 *    `127.0.0.1` — and `CM_ALLOWED_IPS` is enforced on `getClientIp`, which
 *    reads the `x-real-ip` the server sets from `socket.remoteAddress`
 *    (`src/lib/security/ip-restriction.ts`). A request the server makes to
 *    itself is therefore inside every allowlist that names loopback.
 *
 * `'manual'` turns every 3xx into a response with `ok === false`, which each
 * caller below already treats as "this is not our server".
 *
 * Applied through {@link loopbackFetch} rather than at each call site so there is
 * one place to regress, and spread *after* the caller's `init` so no caller can
 * put it back to `follow` by accident.
 */
export const OPENCODE_FETCH_REDIRECT: RequestRedirect = 'manual';

/**
 * `application/json`, which is what opencode answers on every JSON route.
 *
 * Measured on 1.18.21 (Issue #1931): `/global/health`, `/permission`,
 * `/question`, `/session/status` and both reply endpoints all send the bare type
 * with no parameters — on their 400 and 404 replies too.
 */
export const OPENCODE_JSON_CONTENT_TYPE = 'application/json';

/**
 * `text/event-stream`, which is what `GET /event` answers.
 *
 * Load-bearing rather than cosmetic. The same measurement found that an
 * *unknown* route on a real opencode server answers **`200 text/html`** — the
 * web UI's SPA shell, not a 404. So a server on this port that does not have the
 * route CommandMate wants hands back a success with a body, and without this
 * check {@link openOpencodeEventStream} would hold an HTML page open, report the
 * subscription `live`, and yield frames forever at a rate of none.
 */
export const OPENCODE_EVENT_CONTENT_TYPE = 'text/event-stream';

/**
 * One request to the loopback server, with redirects refused.
 *
 * @param url - Absolute URL on the loopback server
 * @param init - Method / body / signal. `redirect` is overridden, on purpose
 */
async function loopbackFetch(url: string, init: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: OPENCODE_FETCH_REDIRECT });
}

/**
 * Whether a response says it is the media type this call can read.
 *
 * The type alone, lower-cased: a `; charset=…` parameter is legal even though
 * 1.18.21 sends none. A response with no `content-type` at all is *not* accepted
 * — opencode always sends one, so its absence means something else answered.
 */
function hasContentType(response: Response, expected: string): boolean {
  const header = response.headers?.get?.('content-type');
  if (typeof header !== 'string') return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === expected;
}

/** One SSE frame: `{ id, type, properties }`. */
export type OpencodeFrame = Record<string, unknown>;

/** `http://127.0.0.1:<port>`. */
export function opencodeBaseUrl(port: number): string {
  return `http://${OPENCODE_SERVER_HOST}:${port}`;
}

/** What `/global/health` answers. */
export interface OpencodeHealth {
  healthy: boolean;
  /** e.g. `1.18.3`, or null when the field is missing. */
  version: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One JSON request, with a timeout, that answers null instead of throwing.
 *
 * @param url - Absolute URL on the loopback server
 * @param init - Method / body; a timeout signal is added
 * @returns The parsed body, or null on any failure at all
 */
async function requestJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await loopbackFetch(url, {
      ...init,
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
    // A 3xx lands here rather than at its target, because of the `redirect`
    // above; a squatter's SPA shell lands here as a 200 that is not JSON.
    if (!response.ok) return null;
    if (!hasContentType(response, OPENCODE_JSON_CONTENT_TYPE)) {
      logger.debug('opencode-request-content-type', {
        url,
        contentType: response.headers?.get?.('content-type') ?? null,
      });
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    // Includes the ordinary case: nothing is listening because the pane exited.
    logger.debug('opencode-request-failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * What a health probe found, told apart by whether asking again could help.
 *
 * `fetchOpencodeHealth` collapses all three into null, which is the right
 * answer for a caller that only wants to know whether to subscribe. It is the
 * wrong answer for one that is deciding whether to *retry* (Issue #1900): a
 * refused connection is a server that has not finished booting and is worth
 * another probe a second later, while a 401 is a server that will answer 401
 * forever — `OPENCODE_SERVER_PASSWORD` in the pane's environment turns every
 * request CommandMate makes into one (#1900 item 4), and retrying it just
 * delays the fall back to the scraper.
 */
export type OpencodeHealthOutcome =
  /** An opencode server answered and is healthy. */
  | { kind: 'healthy'; health: OpencodeHealth }
  /** Nothing answered. Ordinary while a TUI is still starting. */
  | { kind: 'refused'; error: string }
  /**
   * Something answered and it cannot be used — an HTTP error, or a body that
   * is not opencode's health document. `status` is 0 for the latter.
   */
  | { kind: 'rejected'; status: number };

/**
 * Ask whether an opencode server is listening on this port, and say what kind
 * of no it was (Issue #1900).
 */
export async function probeOpencodeHealth(port: number): Promise<OpencodeHealthOutcome> {
  const url = `${opencodeBaseUrl(port)}/global/health`;
  let response: Response;
  try {
    response = await loopbackFetch(url, {
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('opencode-request-failed', { url, error: message });
    return { kind: 'refused', error: message };
  }
  // A 3xx is `rejected`, not `refused`, and that classification is the point:
  // `refused` is retried on the way back up (a server still booting), while a
  // process that answers a redirect will answer one again. Retrying it would
  // only delay the fall back to the scraper.
  if (!response.ok) return { kind: 'rejected', status: response.status };
  if (!hasContentType(response, OPENCODE_JSON_CONTENT_TYPE)) {
    return { kind: 'rejected', status: 0 };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return { kind: 'rejected', status: response.status };
  }
  if (!isPlainObject(body) || body.healthy !== true) return { kind: 'rejected', status: 0 };
  return {
    kind: 'healthy',
    health: { healthy: true, version: typeof body.version === 'string' ? body.version : null },
  };
}

/**
 * Ask whether an opencode server is listening on this port.
 *
 * @returns Its health and version, or null when nothing answered
 */
export async function fetchOpencodeHealth(port: number): Promise<OpencodeHealth | null> {
  const outcome = await probeOpencodeHealth(port);
  return outcome.kind === 'healthy' ? outcome.health : null;
}

/** An array body, or an empty array — `GET /permission` answers a bare array. */
function asObjectArray(body: unknown): Record<string, unknown>[] {
  if (!Array.isArray(body)) return [];
  return body.filter(isPlainObject);
}

/**
 * The approvals currently waiting on a human (#1758 §5.4).
 *
 * This is what makes a missed `permission.asked` recoverable: the event is
 * gone, but the pending state is still readable, which is the whole of the
 * reconnect strategy since `?after=<seq>` returns nothing.
 */
export async function fetchOpencodePendingPermissions(
  port: number
): Promise<Record<string, unknown>[]> {
  return asObjectArray(await requestJson(`${opencodeBaseUrl(port)}/permission`));
}

/** The questions currently waiting on a human. */
export async function fetchOpencodePendingQuestions(
  port: number
): Promise<Record<string, unknown>[]> {
  return asObjectArray(await requestJson(`${opencodeBaseUrl(port)}/question`));
}

/** What one session is doing, per `GET /session/status`. */
export type OpencodeSessionActivity = 'busy' | 'idle';

/**
 * Cap on sessions read back from one `/session/status` (§4 D3, DR4-009).
 *
 * The document comes off a process CommandMate did not start, and one server's
 * `opencode.db` is shared by every TUI with the same HOME and project (#1758
 * §5.6.3), so the map is not bounded by this instance's own behaviour.
 */
export const MAX_OPENCODE_SESSION_STATUSES = 128;

/**
 * What every session on this server is doing (#1758 §5.7.4).
 *
 * `GET /session/status` answers `{"ses_…":{"type":"busy"|"idle"}}`. Note what
 * this does *not* answer: a session blocked on an approval reads `busy`, so
 * this says "the turn is not over", never "the agent is thinking".
 *
 * Per-session rather than aggregated, because a reconnect has to decide about
 * *one* turn (Issue #1900): "something on this server is busy" cannot tell a
 * parent session that is still working from a sub-agent's that is.
 *
 * @returns The map, or null when the server could not be asked. An entry whose
 *   `type` is neither word is dropped rather than guessed at
 */
export async function fetchOpencodeSessionStatuses(
  port: number
): Promise<Record<string, OpencodeSessionActivity> | null> {
  const body = await requestJson(`${opencodeBaseUrl(port)}/session/status`);
  if (!isPlainObject(body)) return null;
  const statuses: Record<string, OpencodeSessionActivity> = {};
  let read = 0;
  for (const [sessionId, value] of Object.entries(body)) {
    if (read >= MAX_OPENCODE_SESSION_STATUSES) {
      logger.warn('opencode-session-status-truncated', {
        port,
        kept: read,
        total: Object.keys(body).length,
        limit: MAX_OPENCODE_SESSION_STATUSES,
      });
      break;
    }
    if (!isPlainObject(value)) continue;
    if (value.type !== 'busy' && value.type !== 'idle') continue;
    statuses[sessionId] = value.type;
    read += 1;
  }
  return statuses;
}

/**
 * Whether any session on this server is working (#1758 §5.7.4).
 *
 * The aggregate view of {@link fetchOpencodeSessionStatuses}, which is what
 * `AgentEventSource.probeActivity` promises its callers — they hold an instance,
 * not a session id.
 *
 * @returns `busy` when any session is busy, `idle` when none is, null when the
 *   server could not be asked
 */
export async function fetchOpencodeActivity(port: number): Promise<'busy' | 'idle' | null> {
  const statuses = await fetchOpencodeSessionStatuses(port);
  if (statuses === null) return null;
  return Object.values(statuses).includes('busy') ? 'busy' : 'idle';
}

/** The three answers opencode accepts for an approval (#1758 §5.5.1). */
export type OpencodePermissionReply = 'once' | 'always' | 'reject';

/**
 * Answer one approval.
 *
 * @param port - The instance's server
 * @param requestId - `per_…`, from `permission.asked` / `GET /permission`
 * @param reply - `once` runs it and asks again next time; `always` saves the
 *   pattern; `reject` fails the tool call
 * @param message - Shown to the agent verbatim on a rejection. Only this
 *   endpoint can carry it
 * @returns Whether the server accepted it
 */
export async function replyOpencodePermission(
  port: number,
  requestId: string,
  reply: OpencodePermissionReply,
  message?: string
): Promise<boolean> {
  const body: Record<string, unknown> = { reply };
  if (message) body.message = message;
  const result = await requestJson(`${opencodeBaseUrl(port)}/permission/${encodeURIComponent(requestId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return result !== null;
}

/**
 * Answer one question.
 *
 * @param answers - One array of selected labels per question, in the order the
 *   `question.asked` frame listed them
 */
export async function replyOpencodeQuestion(
  port: number,
  questionId: string,
  answers: string[][]
): Promise<boolean> {
  const result = await requestJson(`${opencodeBaseUrl(port)}/question/${encodeURIComponent(questionId)}/reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  });
  return result !== null;
}

// =============================================================================
// SSE
// =============================================================================

/**
 * Cap on one SSE frame, in characters (Issue #1931, §10.4).
 *
 * 256 Ki, which is the design's 256 KiB counted in the unit the parser actually
 * holds: it accumulates a JavaScript string, so a byte-exact bound would mean
 * re-encoding every line. A character is one to four UTF-8 bytes, so this is a
 * bound in either unit at the same order — and a bound is the whole point. The
 * largest captured opencode frame is under 8 KiB.
 *
 * Two things are being bounded, and only the second is hostile. A server that
 * sends a frame far larger than anything measured is a version CommandMate does
 * not understand; a process that took the port and streams bytes with no line
 * or frame boundary at all is memory exhaustion in one socket, because a naive
 * parser holds every byte it has not yet been able to split.
 */
export const MAX_OPENCODE_SSE_FRAME_CHARS = 256 * 1024;

/** What {@link createSseParser} exposes. */
export interface OpencodeSseParser {
  push(chunk: string): string[];
  flush(): string[];
  /** How many frames this parser has thrown away for being over the cap. */
  oversizedFrames(): number;
}

/**
 * Incremental parser for the one SSE shape opencode emits.
 *
 * `GET /event` sends frames with no `event:` line — a `data:` line, then a
 * blank line. Multi-line `data:` is joined with `\n` per the SSE spec, though
 * 1.18.3 has never been observed to send one; supporting it costs a line and
 * removes a class of silent truncation.
 *
 * A frame over {@link MAX_OPENCODE_SSE_FRAME_CHARS} is dropped — along with the
 * rest of its lines, up to the next frame boundary — and counted, rather than
 * ending the stream. That is a deliberate departure from "discard and
 * reconnect" (Issue #1931): tearing the connection down over one fat frame
 * costs a full re-sync of `/permission`, `/question` and `/session/status`, and
 * on a stream where the fat frame *repeats* it costs the live subscription
 * entirely. The reconnect still happens in the case that needs it — a socket
 * whose only traffic is oversized yields no frames, so nothing re-arms the
 * heartbeat watchdog and the subscription drops and re-verifies the port's
 * identity on its own.
 *
 * @returns A parser whose `push` returns whatever frames the chunk completed
 */
export function createSseParser(): OpencodeSseParser {
  let buffer = '';
  let dataLines: string[] = [];
  let dataChars = 0;
  /** Dropping the remainder of a frame that already went over the cap. */
  let discarding = false;
  let oversized = 0;
  const completed: string[] = [];

  const dropOversizedFrame = (): void => {
    dataLines = [];
    dataChars = 0;
    discarding = true;
    oversized += 1;
  };

  const finishEvent = (): void => {
    if (dataLines.length === 0) return;
    completed.push(dataLines.join('\n'));
    dataLines = [];
    dataChars = 0;
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      // A blank line ends the frame either way: the good one is emitted, the
      // oversized one is what the parser has been waiting to stop dropping.
      if (discarding) discarding = false;
      else finishEvent();
      return;
    }
    if (discarding) return;
    if (line.startsWith(':')) return; // comment / keepalive
    if (line.startsWith('data:')) {
      const data = line.slice(5).replace(/^ /, '');
      if (dataChars + data.length > MAX_OPENCODE_SSE_FRAME_CHARS) {
        dropOversizedFrame();
        return;
      }
      dataLines.push(data);
      dataChars += data.length;
    }
    // `id:` / `event:` / `retry:` are not used by this server; ignored.
  };

  return {
    push(chunk: string): string[] {
      buffer += chunk;
      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex >= 0) {
        consumeLine(buffer.slice(0, newlineIndex));
        buffer = buffer.slice(newlineIndex + 1);
        newlineIndex = buffer.indexOf('\n');
      }
      // Nothing above can bound a sender that never sends a newline: the whole
      // stream stays in `buffer` as one unsplittable line. Drop it and resume at
      // the next boundary, which is the same treatment an oversized frame gets.
      if (buffer.length > MAX_OPENCODE_SSE_FRAME_CHARS) {
        buffer = '';
        dropOversizedFrame();
      }
      return completed.splice(0, completed.length);
    },
    flush(): string[] {
      if (buffer !== '') {
        consumeLine(buffer);
        buffer = '';
      }
      if (discarding) discarding = false;
      else finishEvent();
      return completed.splice(0, completed.length);
    },
    oversizedFrames(): number {
      return oversized;
    },
  };
}

/**
 * Subscribe to one server's event stream — connect first, iterate second.
 *
 * The returned generator yields parsed frames until the connection ends or
 * `signal` aborts. A frame that is not JSON is skipped rather than ending the
 * stream: a malformed line is a bug in one frame, not a reason to stop watching
 * the session. Ending is normal and is the caller's cue to reconnect — the
 * connection dies without a clean EOF when the server goes away (`transfer
 * closed with outstanding read data remaining`, #1758 §5.7.2).
 *
 * The two halves are split because *when* the subscription became live is a
 * fact the caller needs and a generator cannot give it (Issue #1900 item 5): a
 * generator does not issue its `fetch` until somebody pulls the first frame, so
 * a caller that re-read `GET /permission` before starting to iterate was
 * re-reading a server it had not subscribed to yet. An approval raised in that
 * window appeared on neither side and stayed invisible until the next
 * reconnect. This call resolves once the response headers are in, which is the
 * instant the server has accepted the subscription — everything raised after it
 * arrives on the returned stream.
 *
 * @param port - The instance's server
 * @param signal - Aborted by the subscription to close the stream
 * @returns The frames, from the moment of connection
 */
export async function openOpencodeEventStream(
  port: number,
  signal: AbortSignal
): Promise<AsyncGenerator<OpencodeFrame>> {
  const response = await loopbackFetch(`${opencodeBaseUrl(port)}/event`, {
    signal,
    headers: { Accept: OPENCODE_EVENT_CONTENT_TYPE },
  });
  if (!response.ok || !response.body) {
    throw new Error(`opencode /event responded ${response.status}`);
  }
  if (!hasContentType(response, OPENCODE_EVENT_CONTENT_TYPE)) {
    // Measured: an unknown route answers `200 text/html`, so "the socket
    // accepted me" is not "the subscription exists". Throwing hands the caller
    // its ordinary reconnect, which re-checks the identity first.
    throw new Error(
      `opencode /event answered ${response.headers?.get?.('content-type') ?? 'no content-type'}`
    );
  }
  return iterateOpencodeFrames(port, response.body.getReader());
}

/** Parse an open body into frames until it ends. */
async function* iterateOpencodeFrames(
  port: number,
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<OpencodeFrame> {
  const decoder = new TextDecoder();
  const parser = createSseParser();
  let reportedOversized = 0;

  // A silent cap is a cap nobody can act on: the frame is gone either way, and
  // the count is the only thing that says so.
  const reportOversized = (): void => {
    const dropped = parser.oversizedFrames();
    if (dropped === reportedOversized) return;
    logger.warn('opencode-sse-frame-oversized', {
      port,
      dropped,
      newlyDropped: dropped - reportedOversized,
      limitChars: MAX_OPENCODE_SSE_FRAME_CHARS,
    });
    reportedOversized = dropped;
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const raw of parser.push(chunk)) {
        const frame = safeParseFrame(raw);
        if (frame) yield frame;
      }
      reportOversized();
    }
    for (const raw of parser.flush()) {
      const frame = safeParseFrame(raw);
      if (frame) yield frame;
    }
    reportOversized();
  } finally {
    // `cancel` on an already-aborted stream rejects; the connection is going
    // away either way, so the failure is not actionable.
    await reader.cancel().catch(() => {});
  }
}

/** JSON, or null when the frame was not an object. */
function safeParseFrame(raw: string): OpencodeFrame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}
