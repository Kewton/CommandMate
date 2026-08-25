/**
 * The session-level calls CommandMate makes to one opencode instance's own
 * server (Issue #2038).
 *
 * `../hooks/sources/opencode/client` holds the calls the *event pipeline*
 * makes — health, pending approvals, the SSE stream. These are the calls the
 * *operator* makes: read one session back, open the TUI's session picker, start
 * a new session, fork the current one. They live here rather than there because
 * #2038 is not allowed to change that module (two other Issues are editing it
 * in parallel), and because the two sets have different callers: nothing in the
 * ingest path needs a fork button.
 *
 * The transport rules are imported rather than re-decided —
 * `OPENCODE_FETCH_REDIRECT`, `OPENCODE_REQUEST_TIMEOUT_MS`,
 * `OPENCODE_JSON_CONTENT_TYPE`, `opencodeBaseUrl` are the same constants the
 * event client uses — so a change to "how CommandMate talks to opencode" still
 * has one home. What is duplicated is the six-line wrapper around them, because
 * that wrapper is not exported.
 *
 * ## Measured against opencode 1.18.22 (headless `opencode serve`, isolated HOME)
 *
 * - `GET /session/<id>` → 200 with `{ id, directory, title, time, … }`;
 *   `parentID` is present **only** on a sub-agent's session. 404
 *   `{"name":"NotFoundError"}` for an id that does not exist.
 * - `POST /session/<id>/fork` → 200 with a whole new `Session`, titled
 *   `"<original> (fork #1)"`. The fork carries **no `parentID`** — it is a
 *   sibling, not a child, which is why forking does not make the resumed
 *   session look like a sub-agent to `./opencode-session-recall`.
 * - `POST /tui/open-sessions` and `POST /tui/execute-command` → `true` / 200
 *   **even with no TUI attached at all**. The body means "the command was
 *   accepted onto the TUI control channel", never "the dialog is on screen", so
 *   callers must not report success to a human as though the picker opened.
 * - `GET /session` (no query) returned sessions belonging to *other
 *   directories* — a server started in directory A listed directory B's
 *   sessions, both `projectID: "global"`. That is #1758 §5.6.3 re-measured, and
 *   it is why there is no "list this instance's sessions" call in this module:
 *   the answer would be the whole HOME. The TUI's own picker
 *   ({@link openOpencodeSessionPicker}) is the session list opencode is willing
 *   to scope for itself.
 *
 * Every function answers null / false instead of throwing. A pane whose server
 * has gone is the ordinary case, and none of these calls is load-bearing for a
 * session that is already running.
 *
 * @module lib/session/opencode-session-api
 */

import { createLogger } from '@/lib/logger';
import {
  OPENCODE_FETCH_REDIRECT,
  OPENCODE_JSON_CONTENT_TYPE,
  OPENCODE_REQUEST_TIMEOUT_MS,
  opencodeBaseUrl,
} from '@/lib/hooks/sources/opencode/client';
import { MAX_OPENCODE_SESSION_TITLE_LENGTH, isOpencodeSessionId } from './opencode-session-store';

const logger = createLogger('lib/session/opencode-session-api');

/**
 * The TUI command that starts a fresh session (Issue #2038).
 *
 * `/tui/execute-command` takes opencode's own command id rather than the
 * slash-command text, and this is the id behind the TUI's "New session". The
 * Issue named `/new` as the alternative; typing a slash command into the
 * composer is not available here — CommandMate would have to send keystrokes
 * into the pane and read them back, which is exactly the scraping this endpoint
 * replaces.
 */
export const OPENCODE_TUI_NEW_SESSION_COMMAND = 'session_new';

/** One session, as opencode describes it. */
export interface OpencodeSessionInfo {
  id: string;
  /** `Session.title` — required by the server's schema, so never absent. */
  title: string | null;
  /** `Session.directory` — the absolute path the session belongs to. */
  directory: string | null;
  /** `Session.parentID` — present only on a sub-agent's session. */
  parentId: string | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(record: Record<string, unknown>, key: string): string | null {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** Whether a response says it is the media type this call can read. */
function hasJsonContentType(response: Response): boolean {
  const header = response.headers?.get?.('content-type');
  if (typeof header !== 'string') return false;
  return header.split(';', 1)[0]?.trim().toLowerCase() === OPENCODE_JSON_CONTENT_TYPE;
}

/**
 * One JSON request to the instance's own server, answering null on any failure.
 *
 * Mirrors `client.ts`'s unexported `requestJson`, including the two guards that
 * are not obvious: redirects are refused (a 3xx lands here rather than at its
 * target) and a 200 whose body is not JSON is discarded — an unknown route on a
 * real opencode server answers `200 text/html` with the web UI's SPA shell,
 * so "the request succeeded" is not the same question as "opencode answered".
 */
async function requestJson(url: string, init?: RequestInit): Promise<unknown | null> {
  try {
    const response = await fetch(url, {
      ...init,
      redirect: OPENCODE_FETCH_REDIRECT,
      signal: AbortSignal.timeout(OPENCODE_REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    if (!hasJsonContentType(response)) {
      logger.debug('opencode-session-request-content-type', {
        url,
        contentType: response.headers?.get?.('content-type') ?? null,
      });
      return null;
    }
    return (await response.json()) as unknown;
  } catch (error) {
    // Includes the ordinary case: nothing is listening because the pane exited.
    logger.debug('opencode-session-request-failed', {
      url,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** Parse a `Session` body, or null when it is not one. */
export function toOpencodeSessionInfo(body: unknown): OpencodeSessionInfo | null {
  if (!isPlainObject(body)) return null;
  const id = readString(body, 'id');
  if (!isOpencodeSessionId(id)) return null;
  const title = readString(body, 'title');
  return {
    id,
    title: title === null ? null : title.slice(0, MAX_OPENCODE_SESSION_TITLE_LENGTH),
    directory: readString(body, 'directory'),
    parentId: readString(body, 'parentID'),
  };
}

/**
 * Read one session back from the instance's server.
 *
 * The single-session read, never `GET /session`: the list is HOME-wide (see the
 * module comment), the read is by id.
 *
 * @param port - The port this instance's TUI was launched on
 * @param sessionId - The session to describe
 * @returns The session, or null when it is gone / the server is gone
 */
export async function fetchOpencodeSession(
  port: number,
  sessionId: string
): Promise<OpencodeSessionInfo | null> {
  if (!isOpencodeSessionId(sessionId)) return null;
  const body = await requestJson(
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}`
  );
  return toOpencodeSessionInfo(body);
}

/**
 * Branch a session, leaving the original untouched.
 *
 * @param port - The port this instance's TUI was launched on
 * @param sessionId - The session to fork
 * @returns The new session, or null when the fork did not happen
 */
export async function forkOpencodeSession(
  port: number,
  sessionId: string
): Promise<OpencodeSessionInfo | null> {
  if (!isOpencodeSessionId(sessionId)) return null;
  const body = await requestJson(
    `${opencodeBaseUrl(port)}/session/${encodeURIComponent(sessionId)}/fork`,
    {
      method: 'POST',
      headers: { 'content-type': OPENCODE_JSON_CONTENT_TYPE },
      body: '{}',
    }
  );
  return toOpencodeSessionInfo(body);
}

/**
 * Ask the TUI to open its session picker.
 *
 * Returns whether the command was *accepted*. It is not evidence the dialog is
 * up — measured, a headless server with no TUI at all answers `true` — and the
 * caller is expected to say so to the operator rather than claim the list
 * opened.
 */
export async function openOpencodeSessionPicker(port: number): Promise<boolean> {
  const body = await requestJson(`${opencodeBaseUrl(port)}/tui/open-sessions`, {
    method: 'POST',
    headers: { 'content-type': OPENCODE_JSON_CONTENT_TYPE },
    body: '{}',
  });
  return body === true;
}

/**
 * Run one of the TUI's own commands.
 *
 * Same "accepted, not performed" caveat as {@link openOpencodeSessionPicker}.
 */
export async function executeOpencodeTuiCommand(
  port: number,
  command: string
): Promise<boolean> {
  const body = await requestJson(`${opencodeBaseUrl(port)}/tui/execute-command`, {
    method: 'POST',
    headers: { 'content-type': OPENCODE_JSON_CONTENT_TYPE },
    body: JSON.stringify({ command }),
  });
  return body === true;
}

/**
 * Navigate the TUI to a session it is not currently showing.
 *
 * Sent after a fork, because forking alone leaves the pane on the original
 * conversation — the operator pressed "fork" and would otherwise see nothing
 * happen. Same "accepted, not performed" caveat as the two above.
 */
export async function selectOpencodeSession(
  port: number,
  sessionId: string
): Promise<boolean> {
  if (!isOpencodeSessionId(sessionId)) return false;
  const body = await requestJson(`${opencodeBaseUrl(port)}/tui/select-session`, {
    method: 'POST',
    headers: { 'content-type': OPENCODE_JSON_CONTENT_TYPE },
    body: JSON.stringify({ sessionID: sessionId }),
  });
  return body === true;
}
