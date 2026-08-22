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
 * Four measurements shape the choices below.
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
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
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
    response = await fetch(url, { signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.debug('opencode-request-failed', { url, error: message });
    return { kind: 'refused', error: message };
  }
  if (!response.ok) return { kind: 'rejected', status: response.status };

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
 * Incremental parser for the one SSE shape opencode emits.
 *
 * `GET /event` sends frames with no `event:` line — a `data:` line, then a
 * blank line. Multi-line `data:` is joined with `\n` per the SSE spec, though
 * 1.18.3 has never been observed to send one; supporting it costs a line and
 * removes a class of silent truncation.
 *
 * @returns A parser whose `push` returns whatever frames the chunk completed
 */
export function createSseParser(): { push(chunk: string): string[]; flush(): string[] } {
  let buffer = '';
  let dataLines: string[] = [];
  const completed: string[] = [];

  const finishEvent = (): void => {
    if (dataLines.length === 0) return;
    completed.push(dataLines.join('\n'));
    dataLines = [];
  };

  const consumeLine = (rawLine: string): void => {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
    if (line === '') {
      finishEvent();
      return;
    }
    if (line.startsWith(':')) return; // comment / keepalive
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''));
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
      return completed.splice(0, completed.length);
    },
    flush(): string[] {
      if (buffer !== '') {
        consumeLine(buffer);
        buffer = '';
      }
      finishEvent();
      return completed.splice(0, completed.length);
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
  const response = await fetch(`${opencodeBaseUrl(port)}/event`, {
    signal,
    headers: { Accept: 'text/event-stream' },
  });
  if (!response.ok || !response.body) {
    throw new Error(`opencode /event responded ${response.status}`);
  }
  return iterateOpencodeFrames(response.body.getReader());
}

/** Parse an open body into frames until it ends. */
async function* iterateOpencodeFrames(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<OpencodeFrame> {
  const decoder = new TextDecoder();
  const parser = createSseParser();

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const raw of parser.push(chunk)) {
        const frame = safeParseFrame(raw);
        if (frame) yield frame;
      }
    }
    for (const raw of parser.flush()) {
      const frame = safeParseFrame(raw);
      if (frame) yield frame;
    }
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
