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

import { randomBytes } from 'crypto';
import { pathToFileURL } from 'url';
import { createLogger } from '@/lib/logger';
import type {
  OpencodeAgentChoice,
  OpencodeModelChoice,
  OpencodeProviderChoice,
} from '@/types/opencode-instance-settings';
import { readOpencodeShareMode, readOpencodeShareUrl } from '@/types/opencode-share';
import type { OpencodeShareMode } from '@/types/opencode-share';

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

/**
 * Stop the turn one session is running (Issue #2034).
 *
 * `POST /session/:id/abort`. Measured live on **1.18.22** — isolated HOME, an
 * `opencode serve` on 127.0.0.1:4298, LM Studio as the provider, a generation
 * aborted 6 s in:
 *
 * ```
 * HTTP/1.1 200 OK
 * Content-Type: application/json
 * Content-Length: 4
 *
 * true
 * ```
 *
 * and on the event stream, in the same millisecond as the reply:
 *
 * ```
 * 10:17:25.946  session.error   MessageAbortedError
 * 10:17:25.946  session.status  idle
 * 10:17:25.946  session.idle          <- 1st
 * 10:17:25.969  session.idle          <- 2nd, 23 ms later
 * ```
 *
 * Two consequences for the caller, and neither is visible from the status code:
 *
 *  - **`true` is "accepted", not "a turn was stopped".** Aborting the SAME
 *    session again once it was already idle answered `200 true` as well, and
 *    emitted one more `session.idle`. So the reply cannot confirm the turn
 *    ended; only the event can — see `./subscription`'s idle watch.
 *  - **The idle can arrive before this promise resolves.** It did here: the
 *    frame is emitted while the request is still in flight. A caller that
 *    starts watching *after* awaiting this call can miss its own completion.
 *
 * `true` is required rather than "not null" because the route's own schema
 * (`GET /doc`, `operationId: session.abort`) declares a bare boolean body: a
 * `false` is the server saying it did not take the request, and `requestJson`
 * would hand that back as a perfectly good parsed body.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`, the session whose turn should stop
 * @returns Whether the server accepted the abort
 */
export async function abortOpencodeSession(port: number, sessionId: string): Promise<boolean> {
  const result = await requestJson(
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/abort`,
    { method: 'POST' }
  );
  return result === true;
}

/**
 * One part of a prompt posted to `POST /session/:id/prompt_async`.
 *
 * The two shapes CommandMate sends, out of the four the route's own schema
 * accepts (`GET /doc`, `operationId: session.prompt_async`): `TextPartInput` and
 * `FilePartInput`. `AgentPartInput` / `SubtaskPartInput` address opencode's own
 * sub-agent machinery and have no CommandMate caller.
 *
 * `url` on a file part is a **URL, not a path** — see {@link opencodeFileUrl}.
 */
export type OpencodePromptPart =
  | { type: 'text'; text: string }
  | { type: 'file'; mime: string; filename: string; url: string };

/**
 * The `file://` URL for a local file, which is the only form the route takes.
 *
 * Measured on 1.18.22 (Issue #2035). A bare absolute path in `FilePartInput.url`
 * is **accepted with `204` and then silently discarded** — the server answers
 * before it resolves the part, and the resolution failure arrives on the event
 * stream instead:
 *
 * ```
 * session.error  UnknownError
 *   TypeError: "/…/probe.png" cannot be parsed as a URL.
 *     at SessionPrompt.resolveUserPart …
 * ```
 *
 * and the **whole message is dropped, its text part included** — a read-back of
 * the message id answers `404`. So this is not a nicety: a path handed over
 * unencoded loses the operator's message with a success status code on the wire.
 *
 * `pathToFileURL` rather than `'file://' + path` because the difference is
 * exactly the paths people have: a space or a `#` in a worktree name makes the
 * concatenated string a different URL, and non-ASCII makes it an invalid one.
 *
 * @param absolutePath - Absolute path to a local file
 * @returns `file:///…`, percent-encoded
 */
export function opencodeFileUrl(absolutePath: string): string {
  return pathToFileURL(absolutePath).href;
}

/**
 * A message id for a prompt CommandMate is about to post.
 *
 * The route accepts a caller-chosen `messageID` (schema: `pattern: "^msg"`), and
 * that is what makes the send verifiable: the id is known *before* the request,
 * so {@link readOpencodeUserMessage} can ask for that exact message afterwards
 * rather than guessing which of the session's messages was this one. Measured on
 * 1.18.22 — `msg_cmate2035probe0001` was accepted and read back verbatim.
 *
 * The `cmate` infix is deliberate: opencode's own ids are
 * `msg_037794348001Ajss6k50nWrocp`, so a CommandMate-originated message stays
 * identifiable in `opencode.db` afterwards, and the two generators cannot
 * collide.
 */
export function newOpencodeMessageId(): string {
  return `msg_cmate${randomBytes(12).toString('hex')}`;
}

/**
 * What one prompt should run as, when the instance has it configured (#2048).
 *
 * Every field is optional and an absent field is **not** the same as a default:
 * the body below simply does not carry the key, and opencode then applies its
 * own. That distinction is measured rather than assumed, and it is the reason
 * {@link promptSelectionBody} omits keys instead of sending nulls — a turn
 * posted with no `agent` runs as `build` even when the pane was launched
 * `--agent plan` (§20.5), so "omit" and "send the launch value" are two
 * different behaviours and only one of them is what a configured instance wants.
 */
export interface OpencodePromptSelection {
  /** The persona this turn should run as, e.g. `plan`. */
  agent?: string | null;
  /** `{ providerID, modelID }`, both halves or neither. */
  model?: { providerID: string; modelID: string } | null;
  /**
   * The model variant, e.g. `high`.
   *
   * The **only** channel that applies one. The TUI has no `--variant` flag and
   * `opencode.jsonc`'s `agent.<name>.variant` did not reach the turn either;
   * this key did, and `message.updated.info.variant` came back with it
   * (`docs/design/opencode-server-live-verification.md` §20.4).
   */
  variant?: string | null;
}

/**
 * The `prompt_async` body keys a selection contributes, or nothing.
 *
 * Keys are omitted rather than nulled so a request from an instance with no
 * settings is byte-identical to the pre-#2048 one.
 */
export function promptSelectionBody(
  selection: OpencodePromptSelection | null | undefined
): Record<string, unknown> {
  if (!selection) return {};
  const body: Record<string, unknown> = {};
  if (selection.agent) body.agent = selection.agent;
  if (selection.model?.providerID && selection.model.modelID) {
    body.model = {
      providerID: selection.model.providerID,
      modelID: selection.model.modelID,
    };
  }
  if (selection.variant) body.variant = selection.variant;
  return body;
}

/**
 * Post one prompt to a session without waiting for the reply (Issue #2035).
 *
 * `POST /session/:id/prompt_async`. This is the route the send path takes when
 * the instance has a server, and it was chosen over `/tui/append-prompt` +
 * `/tui/submit-prompt` on a measurement, not a preference — see
 * `docs/design/opencode-server-live-verification.md` §11.4. The short version:
 * the `/tui/*` pair drives the TUI's **composer**, so it inherits the composer's
 * state, and a body whose first token matches a slash command opens the command
 * palette and the palette then eats the submit. `/exit` as a message body
 * answered `200 true` on all three calls and produced no message at all. This
 * route does not go through the composer, and the same body arrived verbatim.
 *
 * **`204` means accepted, not delivered.** Three measured ways that gap opens:
 *
 *  - a file part whose `url` is not a URL is dropped along with its whole
 *    message ({@link opencodeFileUrl});
 *  - a server that shares `HOME` + project with this one answers `204` for a
 *    session it can reach through `opencode.db` — and the message then appears
 *    on **neither** this server's event stream nor this pane's screen;
 *  - an unknown route on a real opencode answers `200 text/html` (#1931), which
 *    is why the status is compared exactly rather than through `response.ok`.
 *
 * {@link readOpencodeUserMessage} is the other half, and callers are expected to
 * use it. Nothing here throws.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`, the session the message belongs to
 * @param messageId - `msg_…`, from {@link newOpencodeMessageId}
 * @param parts - The message body; at least one part
 * @returns Whether the server answered `204`
 */
export async function sendOpencodePrompt(
  port: number,
  sessionId: string,
  messageId: string,
  parts: readonly OpencodePromptPart[],
  selection?: OpencodePromptSelection | null
): Promise<boolean> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/prompt_async`;
  try {
    const response = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': OPENCODE_JSON_CONTENT_TYPE },
      body: JSON.stringify({
        messageID: messageId,
        ...promptSelectionBody(selection),
        parts,
      }),
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
    if (response.status !== 204) {
      logger.warn('opencode-prompt-rejected', { port, sessionId, status: response.status });
      return false;
    }
    return true;
  } catch (error) {
    logger.debug('opencode-request-failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * What a read-back of one posted message found (Issue #2035).
 *
 * Three answers rather than two, because the middle one is the whole reason the
 * read-back exists. `missing` is the server saying *this message does not
 * exist* — it was accepted and then dropped — and it is the only outcome that
 * makes re-sending over the keyboard safe. `unknown` is "could not ask", where a
 * re-send may duplicate.
 */
export type OpencodeMessageReadback =
  /** The message exists, is the user's, and these are its text parts. */
  | { kind: 'found'; texts: string[] }
  /** The server answered `404`: nothing was created under this id. */
  | { kind: 'missing' }
  /** The server could not be asked, or answered something unreadable. */
  | { kind: 'unknown'; reason: string };

/**
 * Read back one message by the id it was posted under (Issue #2035).
 *
 * `GET /session/:id/message/:messageID`. The positive evidence for a send, in
 * the same sense `session.idle` is the positive evidence for an abort (#2034):
 * the status code on the way in says the request was taken, and only this says
 * the message exists.
 *
 * Measured on 1.18.22 across five runs: the message was readable on the **first**
 * attempt, 8-23 ms after the POST began — `prompt_async` answers `204` after the
 * message is created, not before. The falsification ran too: a message posted
 * with a malformed file part answered `204` and then `404` here, which is the
 * case the whole ladder is for.
 *
 * `info.role` is checked because the id space is shared with the assistant's
 * messages: a `messageID` that collided with one would otherwise read back as a
 * perfectly good delivery of somebody else's text.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @param messageId - `msg_…`, the id the prompt was posted under
 */
export async function readOpencodeUserMessage(
  port: number,
  sessionId: string,
  messageId: string
): Promise<OpencodeMessageReadback> {
  const url =
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}` +
    `/message/${encodeURIComponent(messageId)}`;
  let response: Response;
  try {
    response = await loopbackFetch(url, {
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    return { kind: 'unknown', reason: error instanceof Error ? error.message : String(error) };
  }

  if (response.status === 404) return { kind: 'missing' };
  if (!response.ok) return { kind: 'unknown', reason: `status ${response.status}` };
  if (!hasContentType(response, OPENCODE_JSON_CONTENT_TYPE)) {
    return { kind: 'unknown', reason: 'content-type' };
  }

  let body: unknown;
  try {
    body = (await response.json()) as unknown;
  } catch {
    return { kind: 'unknown', reason: 'body' };
  }
  if (!isPlainObject(body)) return { kind: 'unknown', reason: 'body' };

  const info = isPlainObject(body.info) ? body.info : null;
  if (info === null || info.role !== 'user') return { kind: 'unknown', reason: 'role' };

  const texts = (Array.isArray(body.parts) ? body.parts : [])
    .filter(isPlainObject)
    .filter((part) => part.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text as string);
  return { kind: 'found', texts };
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
 * Reachable from production since Issue #2039. It was written with #1763's
 * source and then had no caller for a year of Issues: `decideOpencode` routes
 * `{ kind: 'answer' }` here, and nothing in `src/` built that verdict, so a
 * `question.asked` could be displayed and never answered except with arrow
 * keys. What #2039 added is the two mappings above it —
 * `resolveStructuredQuestionAnswer` and the `kind === 'question'` branch of
 * `respondByDecisionId` — not a line of this function.
 *
 * @param answers - One array of selected labels per question, in the order the
 *   `question.asked` frame listed them. Measured shape: `{"answers":[["Blue"]]}`
 *   for the one-question call (#1758 §5.2.4)
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

/**
 * Cap on messages read back from one `GET /session/:id/message` (Issue #2041).
 *
 * Same argument as {@link MAX_OPENCODE_SESSION_STATUSES}: the document comes off
 * a process CommandMate did not start, one server's `opencode.db` is shared by
 * every TUI with the same HOME and project (#1758 §5.6.3), and a session that
 * has been going for a week is not bounded by this instance's behaviour. Two
 * messages per turn measured on 1.18.22 (one user, one or two assistant), so
 * this is roughly 250 turns.
 */
export const MAX_OPENCODE_SESSION_MESSAGES = 500;

/**
 * Every message in one session, with its parts (Issue #2041).
 *
 * `GET /session/:id/message`. The only route to a reply CommandMate did not see
 * arrive: a fresh subscription to `/event` replays **nothing** — measured on
 * 1.18.22, a second SSE connection opened after three completed turns received
 * one `server.connected` frame and then silence — so a turn that ran while this
 * server was down exists only here.
 *
 * The body is an array of `{ info, parts }`. Returned raw rather than parsed
 * because the parsing lives in `./transcript`, which has to read the *same*
 * shape off the event stream and must not have two readers of it.
 *
 * Answers null for every failure, including the ordinary "nothing is listening
 * because the pane exited" — a caller cannot act on the difference and the
 * distinction {@link OpencodeMessageReadback} draws is not available here (a
 * missing session is a 404 that means the same as an unreachable one for a
 * backfill: there is nothing to recover).
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @returns The array, bounded to the newest {@link MAX_OPENCODE_SESSION_MESSAGES}, or null
 */
export async function fetchOpencodeSessionMessages(
  port: number,
  sessionId: string
): Promise<Record<string, unknown>[] | null> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/message`;
  const body = await requestJson(url);
  if (!Array.isArray(body)) return null;
  const entries = body.filter(isPlainObject);
  // Newest kept, and the array stays in the server's own order so `parentID`
  // grouping still sees a turn's messages together.
  return entries.length > MAX_OPENCODE_SESSION_MESSAGES
    ? entries.slice(entries.length - MAX_OPENCODE_SESSION_MESSAGES)
    : entries;
}


// ============================================================================
// Context occupancy (Issue #2042). Appended at the end of the file on purpose:
// #2041 is rewriting this module's neighbours in parallel, and everything below
// is additive — no export above it is touched.
// ============================================================================

/**
 * How many trailing messages are read back to find the last assistant turn.
 *
 * `GET /session/:id/message?limit=N` answers the **last** N messages in
 * chronological order — measured on 1.18.22, see
 * `docs/design/opencode-server-live-verification.md` §14.3. Four is two
 * user/assistant pairs: enough that a turn still streaming (its assistant
 * message exists but has `output === 0`) falls back to the previous completed
 * one, and small enough that the read stays a few KB rather than the whole
 * conversation. A session whose last four messages contain no finished
 * assistant turn answers null, which is the honest answer — it has not spent a
 * turn yet.
 */
export const OPENCODE_CONTEXT_MESSAGE_WINDOW = 4;

/**
 * What one model declares it can hold, as `GET /config/providers` states it.
 *
 * Only `context` is read. `limit.input` is also published and is **not** the
 * denominator: on `github-copilot/claude-sonnet-4.6` it is 936,000 against a
 * `context` of 1,000,000, and opencode's own readout divides by `context`
 * (§14.2 quotes the 1.18.22 bundle).
 */
export async function fetchOpencodeModelContextLimit(
  port: number,
  providerId: string,
  modelId: string
): Promise<number | null> {
  const body = await fetchOpencodeProvidersDocument(port);
  return readOpencodeModelContextLimit(body, providerId, modelId);
}

/**
 * `GET /config/providers`, unparsed — the one reader of that route (#2048).
 *
 * Issue #2042 read this route for `limit.context` and Issue #2048 needs the
 * same document for the *model and variant catalogue* the settings pane offers.
 * Two independent readers of one endpoint is how the two come to disagree about
 * its shape, so both go through here and each takes what it needs from the
 * body. Nothing is cached: the call is a loopback round trip on a route that
 * answers from memory, and the alternative is a cache that has to be invalidated
 * when the operator adds a provider.
 */
async function fetchOpencodeProvidersDocument(port: number): Promise<unknown | null> {
  return requestJson(`${opencodeBaseUrl(port)}/config/providers`);
}

/**
 * `limit.context` for one model, out of a `GET /config/providers` body.
 *
 * Split from the fetch so the arithmetic is testable against a recorded body
 * rather than a live server. Behaviour is #2042's, unchanged: `context` only,
 * and a non-positive value is "no percentage" rather than a divisor.
 */
export function readOpencodeModelContextLimit(
  body: unknown,
  providerId: string,
  modelId: string
): number | null {
  if (!isPlainObject(body)) return null;
  const providers = Array.isArray(body.providers) ? body.providers : [];
  for (const provider of providers) {
    if (!isPlainObject(provider) || provider.id !== providerId) continue;
    const models = isPlainObject(provider.models) ? provider.models : null;
    if (!models) return null;
    const model = models[modelId];
    if (!isPlainObject(model)) return null;
    const limit = isPlainObject(model.limit) ? model.limit : null;
    if (!limit) return null;
    const context = limit.context;
    // A zero or a negative would divide into a percentage nobody can read, and
    // opencode itself treats a falsy `limit.context` as "no percentage".
    if (typeof context !== 'number' || !Number.isFinite(context) || context <= 0) return null;
    return context;
  }
  return null;
}

/**
 * The provider / model / variant catalogue the settings pane offers (#2048).
 *
 * Three shapes measured on 1.18.22 (§20.1), each of which is easy to guess
 * wrong:
 *
 *  - **`providers` is an array, `models` is an object.** The models are keyed by
 *    model id, not listed — `providers[].models["claude-sonnet-4.6"]` — so an
 *    `Array.isArray` guard on it drops every model there is.
 *  - **`variants` is an object too**, keyed by variant name (`low` / `medium` /
 *    `high` / `max` / `minimal` / `none` / `xhigh` across the measured
 *    catalogue), whose values carry `effort` or `reasoningEffort`. Only the keys
 *    are kept: the name is what `prompt_async` takes, and the effort inside it
 *    is opencode's own restatement of the same word.
 *  - **`variants: {}` is a real answer**, not a missing field — `kimi-k2.7-code`
 *    publishes it — and it is how the pane knows to offer no variant at all.
 *
 * Entries that do not parse are dropped rather than represented: this feeds a
 * `<select>`, and an option with no id is an option that cannot be chosen.
 *
 * @param port - The instance's server
 * @returns The catalogue, or an empty array when the server could not be asked
 */
export async function fetchOpencodeProviderCatalog(
  port: number
): Promise<OpencodeProviderChoice[]> {
  return readOpencodeProviderCatalog(await fetchOpencodeProvidersDocument(port));
}

/** {@link fetchOpencodeProviderCatalog}'s parser, over an already-read body. */
export function readOpencodeProviderCatalog(body: unknown): OpencodeProviderChoice[] {
  if (!isPlainObject(body)) return [];
  const providers = Array.isArray(body.providers) ? body.providers : [];
  const catalog: OpencodeProviderChoice[] = [];
  for (const provider of providers) {
    if (!isPlainObject(provider)) continue;
    const id = typeof provider.id === 'string' ? provider.id : null;
    if (!id) continue;
    const models: OpencodeModelChoice[] = [];
    const rawModels = isPlainObject(provider.models) ? provider.models : {};
    for (const [modelId, rawModel] of Object.entries(rawModels)) {
      if (!isPlainObject(rawModel)) continue;
      const variants = isPlainObject(rawModel.variants) ? Object.keys(rawModel.variants) : [];
      models.push({
        id: modelId,
        name: typeof rawModel.name === 'string' && rawModel.name.length > 0
          ? rawModel.name
          : modelId,
        variants: variants.sort(),
      });
    }
    models.sort((a, b) => a.id.localeCompare(b.id));
    catalog.push({
      id,
      name: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : id,
      models,
    });
  }
  catalog.sort((a, b) => a.id.localeCompare(b.id));
  return catalog;
}

/**
 * The personas this server will start a session as — `GET /agent` (#2048).
 *
 * An **array**, unlike `/config/providers`'s object-of-models, and its entries
 * carry two fields that decide what the pane may offer (§20.1): `mode` is
 * `primary` or `subagent`, and `hidden` is `true` on the three internal
 * personas (`compaction`, `summary`, `title`). A stock 1.18.22 install answered
 * seven agents of which exactly two — `build` and `plan` — are primary and
 * visible, which is the pair Issue #2048's acceptance condition names.
 *
 * Both fields are kept rather than filtered here: this is the reader, and which
 * agents a *launch* may name is a policy the caller states —
 * {@link isOpencodeLaunchableAgent}.
 *
 * @param port - The instance's server
 * @returns Every agent the server declared, or an empty array when it could not
 *   be asked
 */
export async function fetchOpencodeAgents(port: number): Promise<OpencodeAgentChoice[]> {
  return readOpencodeAgents(await requestJson(`${opencodeBaseUrl(port)}/agent`));
}

/** {@link fetchOpencodeAgents}'s parser, over an already-read body. */
export function readOpencodeAgents(body: unknown): OpencodeAgentChoice[] {
  if (!Array.isArray(body)) return [];
  const agents: OpencodeAgentChoice[] = [];
  for (const entry of body) {
    if (!isPlainObject(entry)) continue;
    const name = typeof entry.name === 'string' ? entry.name : null;
    if (!name) continue;
    // `hidden` is absent on the visible ones rather than `false`, so the test is
    // truthiness of the key and not a comparison against `false`.
    if (entry.hidden === true) continue;
    agents.push({
      name,
      mode: typeof entry.mode === 'string' ? entry.mode : '',
      description: typeof entry.description === 'string' ? entry.description : null,
    });
  }
  return agents;
}

/**
 * Whether an agent may be named on a launch line or a prompt.
 *
 * `primary` only. A `subagent` (`explore`, `general`) is something a running
 * session spawns for a `task` tool call; naming one as the session's own persona
 * is not a thing opencode's UI offers and not something measured to work.
 */
export function isOpencodeLaunchableAgent(agent: OpencodeAgentChoice): boolean {
  return agent.mode === 'primary';
}

/** A finite, non-negative token count, or 0 — the shape `tokens.*` arrives in. */
function readTokenCount(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * How full this session's context is, in tokens (Issue #2042).
 *
 * **This is not `Session.tokens` and the difference is the whole point.**
 * `session.updated` reports a *cumulative* count — after two turns the measured
 * session read `input 6 / output 11 / cache.read 8482 / cache.write 8500`, which
 * is what `opencode stats` prints and what `AgentSessionRecord` carries.
 * What opencode's own TUI shows as `8.5K (1%)` is a different quantity: the
 * token footprint of the **last assistant message**, which is what the next
 * request actually has to fit into a context window. Summing the session's
 * counts would have said 16,999 where opencode says 8,508, and the gap widens
 * with every turn (§14.2).
 *
 * The rule is opencode's own, transcribed from the 1.18.22 bundle rather than
 * inferred: take the last message with `role === 'assistant'` **and**
 * `tokens.output > 0`, and add `input + output + reasoning + cache.read +
 * cache.write`. The `output > 0` clause is what skips the assistant message a
 * turn opens with, whose counts are all zero until the turn finishes.
 *
 * `tokens.total` on that message is opencode's own sum of exactly those five
 * and was measured equal to it (8491, then 8508) — it is not read here because
 * it is absent until the turn completes, and the five are the definition.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @returns The occupancy in tokens, or null when no finished assistant turn is
 *   in the window (a fresh session, or one whose last four messages are all
 *   user prompts) and on every transport failure
 */
export async function fetchOpencodeContextTokens(
  port: number,
  sessionId: string
): Promise<number | null> {
  const url =
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/message` +
    `?limit=${OPENCODE_CONTEXT_MESSAGE_WINDOW}`;
  const body = await requestJson(url);
  if (!Array.isArray(body)) return null;
  for (let index = body.length - 1; index >= 0; index -= 1) {
    const entry = body[index];
    if (!isPlainObject(entry)) continue;
    // `{ info, parts }`; only `info` carries the counts.
    const info = isPlainObject(entry.info) ? entry.info : null;
    if (!info || info.role !== 'assistant') continue;
    const tokens = isPlainObject(info.tokens) ? info.tokens : null;
    if (!tokens) continue;
    const output = readTokenCount(tokens, 'output');
    if (output <= 0) continue;
    const cache = isPlainObject(tokens.cache) ? tokens.cache : {};
    return (
      readTokenCount(tokens, 'input') +
      output +
      readTokenCount(tokens, 'reasoning') +
      readTokenCount(cache, 'read') +
      readTokenCount(cache, 'write')
    );
  }
  return null;
}


// ============================================================================
// Turn diff, revert and unrevert (Issue #2043). Appended at the end of the file
// for the reason #2042's block above says: nothing here touches an export above
// it, so a parallel branch editing this module's neighbours cannot conflict.
//
// ## What was measured, and how it contradicts Issue #2043's premise
//
// Measured live on opencode **1.18.22** in an isolated `HOME`
// (`docs/design/opencode-server-live-verification.md` §16). Two full turns that
// edited files produced **eight `session.diff` frames and every one carried
// `diff: []`** — including the frame emitted in the same millisecond as
// `session.idle`, after both `file.edited` frames. `session.diff` is therefore
// **not** "the files this turn changed". It is *what a revert is currently
// holding back*: it went non-empty the instant `POST /session/:id/revert`
// returned, naming exactly the files that revert undid.
//
// The turn's changed files come from `GET /session/:id/diff?messageID=<the user
// message that started the turn>`. The same route **without** `messageID`
// answered `[]` on every call, before and after a turn alike.
// ============================================================================

/**
 * One file in an opencode diff — the wire's `SnapshotFileDiff`.
 *
 * `file`, `patch` and `status` are nullable because the server's own OpenAPI
 * (`GET /doc`, 1.18.22) marks only `additions` and `deletions` required. A UI
 * that assumed `file` was always there would render `undefined` as a filename
 * the first time opencode exercised that freedom.
 */
export interface OpencodeFileDiff {
  /** Repository-relative path, or null when the server did not name one. */
  file: string | null;
  /** Unified diff for this file, or null. Rendered verbatim by `DiffViewer`. */
  patch: string | null;
  additions: number;
  deletions: number;
  /** `added` | `deleted` | `modified`, or null. */
  status: OpencodeFileDiffStatus | null;
}

/** The three values 1.18.22's `SnapshotFileDiff.status` enum declares. */
export type OpencodeFileDiffStatus = 'added' | 'deleted' | 'modified';

const OPENCODE_FILE_DIFF_STATUSES: readonly string[] = ['added', 'deleted', 'modified'];

/**
 * Cap on files kept from one diff.
 *
 * A diff is carried on the status poll's payload, and `patch` is unbounded — a
 * generated lockfile is megabytes of it. The cap is on *files* rather than
 * bytes so the panel never shows half a file's name; {@link MAX_OPENCODE_DIFF_PATCH_CHARS}
 * is the byte-side companion.
 */
export const MAX_OPENCODE_DIFF_FILES = 200;

/** Cap on one file's `patch`. Truncated patches still render; huge ones do not. */
export const MAX_OPENCODE_DIFF_PATCH_CHARS = 64 * 1024;

/**
 * Read an array of `SnapshotFileDiff` off any opencode payload.
 *
 * Shared by the event reader and the REST reader on purpose: `session.diff`'s
 * `properties.diff` and `GET /session/:id/diff`'s body are the *same* schema,
 * and two readers of one shape is how they come apart.
 *
 * Entries that are not objects are dropped rather than represented, and a
 * non-array answers the empty array — "the server said nothing readable" and
 * "the server said no files" are the same instruction to a panel that hides
 * itself when empty.
 */
export function readOpencodeFileDiffs(value: unknown): OpencodeFileDiff[] {
  if (!Array.isArray(value)) return [];
  const files: OpencodeFileDiff[] = [];
  for (const entry of value) {
    if (!isPlainObject(entry)) continue;
    const patch = typeof entry.patch === 'string' ? entry.patch : null;
    files.push({
      file: typeof entry.file === 'string' && entry.file.length > 0 ? entry.file : null,
      patch: patch === null ? null : patch.slice(0, MAX_OPENCODE_DIFF_PATCH_CHARS),
      additions: typeof entry.additions === 'number' && Number.isFinite(entry.additions)
        ? entry.additions
        : 0,
      deletions: typeof entry.deletions === 'number' && Number.isFinite(entry.deletions)
        ? entry.deletions
        : 0,
      status:
        typeof entry.status === 'string' && OPENCODE_FILE_DIFF_STATUSES.includes(entry.status)
          ? (entry.status as OpencodeFileDiffStatus)
          : null,
    });
    if (files.length >= MAX_OPENCODE_DIFF_FILES) break;
  }
  return files;
}

/**
 * The files one user message's turn changed (Issue #2043).
 *
 * `GET /session/:id/diff?messageID=<msg…>`. **The `messageID` is not optional in
 * practice**: measured on 1.18.22, the same route without it answered `[]` both
 * before and after a turn that changed two files, while the same call *with* it
 * answered both files and their patches.
 *
 * The answer is a historical record rather than live state — measured: it still
 * returned the turn's two files after that turn had been reverted — so a caller
 * showing "what this turn changed" is reading the right thing, and a caller
 * asking "is this still applied" is not.
 *
 * A malformed `messageID` (one not starting with `msg`) is a **400** from the
 * server, which collapses to null here like every other failure.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @param messageId - `msg_…`, the *user* message that opened the turn
 * @returns The files, or null when the server could not be asked
 */
export async function fetchOpencodeMessageDiff(
  port: number,
  sessionId: string,
  messageId: string
): Promise<OpencodeFileDiff[] | null> {
  const url =
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/diff` +
    `?messageID=${encodeURIComponent(messageId)}`;
  const body = await requestJson(url);
  if (!Array.isArray(body)) return null;
  return readOpencodeFileDiffs(body);
}

/**
 * What a revert or unrevert did, told apart by what the caller can do next.
 *
 * Six outcomes rather than a boolean, because three of them were measured to be
 * indistinguishable from success at the HTTP layer:
 *
 *  - **`no_op`** — `POST /revert` with a well-formed but *nonexistent*
 *    `messageID` answered **200** with `revert: null`. The server did nothing
 *    and said so only in the body. A UI that trusted the status code would
 *    report a revert that never happened.
 *  - **`busy`** — a **409 `SessionBusyError`** while the agent is mid-turn.
 *    Measured for both routes. Recoverable by waiting, unlike `rejected`.
 *  - **`rejected`** — a 400 `BadRequest` (a `messageID` not matching `^msg`),
 *    or any other status. Asking again will not help.
 */
export type OpencodeRevertOutcome =
  /** The session is now holding work back; `messageID` is what it reverted to. */
  | { kind: 'reverted'; messageId: string }
  /** No work is held back any more. The answer to a successful unrevert. */
  | { kind: 'restored' }
  /** 200, but the session came back with no revert: nothing happened. */
  | { kind: 'no_op' }
  /** 409 `SessionBusyError`: the agent is mid-turn. Retryable. */
  | { kind: 'busy' }
  /** The server refused. Not retryable. */
  | { kind: 'rejected'; status: number }
  /** Nothing answered, or the answer was not opencode's. */
  | { kind: 'unreachable' };

/**
 * `Session.revert.messageID`, or null when the session holds nothing back.
 *
 * The one field that distinguishes a revert that took from one that did not,
 * for both routes: `POST /revert` sets it, `POST /unrevert` clears it, and a
 * no-op leaves it as it was.
 */
function readSessionRevertMessageId(body: unknown): string | null {
  if (!isPlainObject(body)) return null;
  const revert = isPlainObject(body.revert) ? body.revert : null;
  if (!revert) return null;
  return typeof revert.messageID === 'string' && revert.messageID.length > 0
    ? revert.messageID
    : null;
}

/** One POST to a revert route, with the three measured statuses kept apart. */
async function postOpencodeRevertRoute(
  url: string,
  body: Record<string, unknown>
): Promise<{ outcome: OpencodeRevertOutcome } | { revertedTo: string | null }> {
  let response: Response;
  try {
    response = await loopbackFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': OPENCODE_JSON_CONTENT_TYPE },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    logger.debug('opencode-request-failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return { outcome: { kind: 'unreachable' } };
  }

  if (response.status === 409) return { outcome: { kind: 'busy' } };
  if (!response.ok) {
    logger.warn('opencode-revert-rejected', { url, status: response.status });
    return { outcome: { kind: 'rejected', status: response.status } };
  }
  // #1931: an unknown route on a real opencode answers `200 text/html`, so a
  // 200 alone does not mean this route exists on the server that answered.
  if (!hasContentType(response, OPENCODE_JSON_CONTENT_TYPE)) {
    return { outcome: { kind: 'unreachable' } };
  }

  try {
    return { revertedTo: readSessionRevertMessageId(await response.json()) };
  } catch {
    return { outcome: { kind: 'unreachable' } };
  }
}

/**
 * Undo one turn's file changes (Issue #2043).
 *
 * `POST /session/:id/revert` with `{ messageID }`. **Destructive and measured to
 * be so**: reverting to the first turn of a two-turn session restored
 * `sample.txt` to its pre-session contents *and deleted* the `added.txt` the
 * agent had created. It rewrites the working tree from opencode's own git
 * snapshot ledger, so it can also undo work that was already committed — the
 * measurement in §16.5 left a clean tree reading ` D added.txt` / ` M
 * sample.txt` afterwards.
 *
 * That is why the caller is expected to confirm first, and why a `no_op` is
 * reported rather than swallowed.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @param messageId - `msg_…`, the user message whose turn is being undone
 */
export async function revertOpencodeMessage(
  port: number,
  sessionId: string,
  messageId: string
): Promise<OpencodeRevertOutcome> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/revert`;
  const result = await postOpencodeRevertRoute(url, { messageID: messageId });
  if ('outcome' in result) return result.outcome;
  // Measured twice, and the second measurement is why this compares ids rather
  // than testing for null. From a session with nothing reverted, an unknown
  // `messageID` answers `200` with `revert: null`. From a session that is
  // **already** holding a revert, the same request answers `200` with the
  // *existing* `revert` untouched — so a null check alone reported success, and
  // reported it under the previous revert's message id. A revert that took
  // echoes the id that was asked for; anything else did nothing.
  return result.revertedTo === messageId
    ? { kind: 'reverted', messageId }
    : { kind: 'no_op' };
}

/**
 * Put back everything a revert is holding (Issue #2043).
 *
 * `POST /session/:id/unrevert`. Takes no arguments — it restores *all*
 * previously reverted messages, per the server's own summary — and answers
 * **200 on a session with nothing reverted**, which is why "restored" here means
 * "nothing is held back now" rather than "something moved".
 *
 * Measured asymmetry worth knowing: a successful unrevert emits **no
 * `session.diff` frame at all**, only `session.updated` with `revert: null`. A
 * reader that waited for `session.diff` to go empty would wait forever, which is
 * why {@link readOpencodeRevertState} reads the session frame too.
 */
export async function unrevertOpencodeSession(
  port: number,
  sessionId: string
): Promise<OpencodeRevertOutcome> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/unrevert`;
  const result = await postOpencodeRevertRoute(url, {});
  if ('outcome' in result) return result.outcome;
  // Here the null check *is* the right test: unrevert takes no argument, so
  // "nothing is held back any more" is the whole success condition. A session
  // that still reports a revert refused to let go of it.
  return result.revertedTo === null
    ? { kind: 'restored' }
    : { kind: 'no_op' };
}

// =============================================================================
// Session sharing (Issue #2051)
// =============================================================================

/**
 * Timeout for the two share routes.
 *
 * Longer than {@link OPENCODE_REQUEST_TIMEOUT_MS}, which bounds loopback calls
 * that opencode answers out of its own process. These two do not stay on the
 * loopback: opencode uploads the session to its hosting and waits for the reply,
 * so the round trip includes somebody else's network. 20s rather than 5s, and
 * still bounded, because the operator is watching a spinner.
 */
export const OPENCODE_SHARE_REQUEST_TIMEOUT_MS = 20_000;

/**
 * The `share` setting this server is running with.
 *
 * A whole `GET /config` fetch for one key, because that is the only place the
 * setting is exposed: there is no `/config/share`, and the value is not on the
 * session. Cheap enough — the measured body is under 200 bytes.
 *
 * @param port - The instance's server
 * @returns The mode, or null when the key is unset, unknown to this build, or
 *   the server could not be asked. `null` must not be read as `'disabled'`;
 *   see `src/types/opencode-share.ts`
 */
export async function fetchOpencodeShareMode(port: number): Promise<OpencodeShareMode | null> {
  const body = await requestJson(`${opencodeBaseUrl(port)}/config`);
  return readOpencodeShareMode(body);
}

/**
 * What a publish attempt did.
 *
 * `refused` rather than `disabled`, because the server does not say which it
 * is. Measured on 1.18.22: publishing with `share: "disabled"` configured comes
 * back as a bare **HTTP 500 `UnknownError`** whose only distinguishing mark
 * (`Error: Sharing is disabled in configuration`) is written to the server's own
 * log. The route in front of this checks `GET /config` first precisely because
 * this outcome cannot be decoded after the fact.
 */
export type OpencodeShareOutcome =
  /** Published. The page at `url` is readable by anyone holding the link. */
  | { kind: 'shared'; url: string }
  /** The server has no such session. */
  | { kind: 'not-found' }
  /** The server answered, and refused. Includes the disabled-in-config case. */
  | { kind: 'refused'; status: number }
  /** The server could not be reached, or answered something unreadable. */
  | { kind: 'failed'; reason: string };

/**
 * Publish one session to opencode's hosting.
 *
 * **This makes the conversation readable by anyone with the link**, under the
 * operator's own credentials. Measured on 1.18.22: the published page carries
 * the session *unredacted* — the prompts, the replies and the absolute
 * `directory` path were all present in the HTML. It is the exact opposite of
 * `opencode export --sanitize`, and nothing between here and the operator
 * removes anything. Every caller must have taken an explicit confirmation
 * first.
 *
 * Written against `requestJson`'s siblings rather than through it because the
 * status code is load-bearing here: `requestJson` collapses every non-2xx to
 * null, and a 404 (no such session) needs telling apart from a 500 (refused).
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @returns The outcome; on success, the URL opencode minted
 */
export async function shareOpencodeSession(
  port: number,
  sessionId: string
): Promise<OpencodeShareOutcome> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/share`;
  try {
    // Measured: the route takes no request body at all (`requestBody: null` in
    // opencode's own OpenAPI), so none is sent.
    const response = await loopbackFetch(url, {
      method: 'POST',
      signal: AbortSignal.timeout(OPENCODE_SHARE_REQUEST_TIMEOUT_MS),
    });
    if (response.status === 404) return { kind: 'not-found' };
    if (!response.ok) {
      logger.warn('opencode-share-refused', { port, sessionId, status: response.status });
      return { kind: 'refused', status: response.status };
    }
    if (!hasContentType(response, OPENCODE_JSON_CONTENT_TYPE)) {
      return { kind: 'failed', reason: 'response was not JSON' };
    }
    const body = (await response.json()) as unknown;
    const shareUrl = readOpencodeShareUrl(body);
    if (shareUrl === null) {
      // A 200 with no usable URL is the one case that must not read as success:
      // the session may well be published, and the operator would be told it is
      // not. Reported as a failure so the UI keeps the revoke path visible.
      logger.warn('opencode-share-no-url', { port, sessionId });
      return { kind: 'failed', reason: 'server returned no share URL' };
    }
    logger.info('opencode-share-created', { port, sessionId });
    return { kind: 'shared', url: shareUrl };
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Take one session's published page down.
 *
 * Measured on 1.18.22, and both halves matter:
 *
 * - It **works**: the public URL stops serving the conversation and renders
 *   opencode's own "Not Found" view instead. Note that the HTTP status stays
 *   **200** — the not-found view is client-rendered — so a caller must not
 *   verify revocation by fetching the URL and testing for 404.
 * - The session **keeps its `share: { url }`** afterwards, in the response to
 *   this very call and in `GET /session/:id`, and it survives a server restart.
 *   So there is no server-side flag saying "currently shared", and this
 *   function's boolean is the only signal a caller gets.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @returns Whether opencode accepted the revocation
 */
export async function unshareOpencodeSession(
  port: number,
  sessionId: string
): Promise<boolean> {
  const url = `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/share`;
  try {
    const response = await loopbackFetch(url, {
      method: 'DELETE',
      signal: AbortSignal.timeout(OPENCODE_SHARE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      logger.warn('opencode-unshare-refused', { port, sessionId, status: response.status });
      return false;
    }
    logger.info('opencode-share-removed', { port, sessionId });
    return true;
  } catch (error) {
    logger.warn('opencode-unshare-failed', {
      port,
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

/**
 * The share URL opencode currently records against one session.
 *
 * A raw `GET /session/:id` rather than `fetchOpencodeSession()`, which projects
 * the body down to `{ id, title, directory, parentId }` and drops `share`
 * along with it.
 *
 * Read what this returns as **"a page was published for this session at some
 * point"**, never as "a page is up now": the field survives
 * {@link unshareOpencodeSession} and a server restart. See that function.
 *
 * @param port - The instance's server
 * @param sessionId - `ses_…`
 * @returns The recorded `https:` URL, or null when there is none
 */
export async function fetchOpencodeSessionShareUrl(
  port: number,
  sessionId: string
): Promise<string | null> {
  const body = await requestJson(
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}`
  );
  return readOpencodeShareUrl(body);
}
