/**
 * HTTP client for an OpenCode V2 server CommandMate started (Issue #2934).
 *
 * Two calls, both to the loopback server `scripts/opencode-v2/launch.sh` runs
 * in the instance's pane:
 *
 *  - {@link probeOpencodeV2Server}: `GET /openapi.json` — the same request the
 *    wrapper waits on before it starts the TUI;
 *  - {@link openOpencodeV2EventStream}: `GET /api/event`, the SSE stream the
 *    subscription reads its state from.
 *
 * Both authenticate with Basic `opencode:<password>`, the password read from
 * the instance's file (`./secrets`) at call time. The value is put into a
 * header and nowhere else — never into a URL, an error message or a log field.
 *
 * Wire format measured on 2.0.18 (#2370 Phase 0): every frame is one
 * `data: {id, created?, type, location?, data, durable?}` line, and between
 * frames the server sends `: heartbeat` comment lines. An unauthenticated
 * request to any route answers 401.
 *
 * @module lib/hooks/sources/opencode-v2/client
 */

import { isPlainObject } from '../event-mapper';

/** The only host OpenCode V2 servers are started on and dialled at. */
export const OPENCODE_V2_SERVER_HOST = '127.0.0.1';

/** The Basic-auth user name `opencode2 serve` expects. */
export const OPENCODE_V2_SERVER_USER = 'opencode';

/** How long one probe may take before it counts as unreachable. */
export const OPENCODE_V2_PROBE_TIMEOUT_MS = 2_000;

/**
 * Largest frame accepted off the stream, in characters.
 *
 * `permission.asked` carries a unified diff in `metadata.files[].patch`, so a
 * frame is not small; but a frame that never ends must not grow without bound
 * inside a long-lived server process either.
 */
export const MAX_OPENCODE_V2_SSE_FRAME_CHARS = 4 * 1024 * 1024;

/** One decoded frame: the envelope object, unvalidated beyond "is an object". */
export type OpencodeV2Frame = Record<string, unknown>;

/** Base URL of an instance's server. */
export function opencodeV2BaseUrl(port: number): string {
  return `http://${OPENCODE_V2_SERVER_HOST}:${port}`;
}

/** The `Authorization` header value for a password. */
export function opencodeV2AuthorizationHeader(password: string): string {
  return `Basic ${Buffer.from(`${OPENCODE_V2_SERVER_USER}:${password}`).toString('base64')}`;
}

/** What {@link probeOpencodeV2Server} learned. */
export type OpencodeV2ProbeOutcome =
  | { kind: 'healthy' }
  | { kind: 'rejected'; status: number }
  | { kind: 'unreachable' };

/**
 * Whether the server on `port` is up and accepts `password`.
 *
 * `rejected` is the answer that matters for reattachment: something is
 * listening, but not a server holding this instance's password — a different
 * process took the port, and subscribing to it would read someone else's
 * events.
 */
export async function probeOpencodeV2Server(
  port: number,
  password: string
): Promise<OpencodeV2ProbeOutcome> {
  try {
    const response = await fetch(`${opencodeV2BaseUrl(port)}/openapi.json`, {
      headers: { Authorization: opencodeV2AuthorizationHeader(password) },
      redirect: 'error',
      signal: AbortSignal.timeout(OPENCODE_V2_PROBE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
    return response.status === 200
      ? { kind: 'healthy' }
      : { kind: 'rejected', status: response.status };
  } catch {
    return { kind: 'unreachable' };
  }
}

/** Something the SSE parser produced. */
export type OpencodeV2SseItem = { kind: 'frame'; data: string } | { kind: 'heartbeat' };

/**
 * An incremental `text/event-stream` parser.
 *
 * Only what OpenCode V2 sends is interpreted: `data:` lines (joined with `\n`
 * when one event spans several) are dispatched on the blank line that ends the
 * event, and a comment line (`: heartbeat`) is reported as a heartbeat so the
 * subscription can tell a quiet stream from a dead one. `event:` / `id:` /
 * `retry:` fields are ignored — the type travels inside the JSON.
 */
export interface OpencodeV2SseParser {
  push(chunk: string): OpencodeV2SseItem[];
  flush(): OpencodeV2SseItem[];
  oversizedFrames(): number;
}

/** A fresh {@link OpencodeV2SseParser}. */
export function createOpencodeV2SseParser(): OpencodeV2SseParser {
  let buffer = '';
  let data: string[] = [];
  let dataChars = 0;
  let oversized = false;
  let oversizedCount = 0;

  const dispatch = (items: OpencodeV2SseItem[]): void => {
    if (oversized) oversizedCount += 1;
    else if (data.length > 0) items.push({ kind: 'frame', data: data.join('\n') });
    data = [];
    dataChars = 0;
    oversized = false;
  };

  const takeLine = (line: string, items: OpencodeV2SseItem[]): void => {
    if (line === '') {
      dispatch(items);
      return;
    }
    if (line.startsWith(':')) {
      items.push({ kind: 'heartbeat' });
      return;
    }
    if (!line.startsWith('data:')) return;
    if (oversized) return;
    const value = line.slice(5).replace(/^ /, '');
    dataChars += value.length;
    if (dataChars > MAX_OPENCODE_V2_SSE_FRAME_CHARS) {
      oversized = true;
      data = [];
      return;
    }
    data.push(value);
  };

  return {
    push(chunk: string): OpencodeV2SseItem[] {
      const items: OpencodeV2SseItem[] = [];
      buffer += chunk;
      let newline = buffer.search(/\r?\n|\r/);
      while (newline !== -1) {
        const line = buffer.slice(0, newline);
        const width = buffer.startsWith('\r\n', newline) ? 2 : 1;
        buffer = buffer.slice(newline + width);
        takeLine(line, items);
        newline = buffer.search(/\r?\n|\r/);
      }
      if (buffer.length > MAX_OPENCODE_V2_SSE_FRAME_CHARS) {
        // One unterminated line longer than any frame: drop it rather than
        // hold it. The event it belongs to is counted as oversized.
        buffer = '';
        oversized = true;
      }
      return items;
    },
    flush(): OpencodeV2SseItem[] {
      const items: OpencodeV2SseItem[] = [];
      if (buffer !== '') takeLine(buffer, items);
      buffer = '';
      dispatch(items);
      return items;
    },
    oversizedFrames(): number {
      return oversizedCount;
    },
  };
}

/** JSON object, or null for anything else. */
export function parseOpencodeV2Frame(raw: string): OpencodeV2Frame | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** What the event stream yields: a decoded frame, or proof the stream is alive. */
export type OpencodeV2StreamItem =
  | { kind: 'frame'; frame: OpencodeV2Frame }
  | { kind: 'heartbeat' };

/**
 * Open `GET /api/event`.
 *
 * Resolves once the response headers are in — the instant the server has
 * accepted the subscription — and rejects on anything but a `200
 * text/event-stream`, so the caller's reconnect loop is the only error path.
 *
 * @param port - The instance's server
 * @param password - The instance's password
 * @param signal - Aborted to close the stream
 */
export async function openOpencodeV2EventStream(
  port: number,
  password: string,
  signal: AbortSignal
): Promise<AsyncGenerator<OpencodeV2StreamItem>> {
  const response = await fetch(`${opencodeV2BaseUrl(port)}/api/event`, {
    signal,
    redirect: 'error',
    headers: {
      Accept: 'text/event-stream',
      Authorization: opencodeV2AuthorizationHeader(password),
    },
  });
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`opencode2 /api/event responded ${response.status}`);
  }
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'text/event-stream') {
    await response.body.cancel().catch(() => {});
    throw new Error(`opencode2 /api/event answered ${contentType ?? 'no content-type'}`);
  }
  return iterateOpencodeV2Stream(response.body.getReader());
}

/** Parse an open body into items until it ends. */
export async function* iterateOpencodeV2Stream(
  reader: ReadableStreamDefaultReader<Uint8Array>
): AsyncGenerator<OpencodeV2StreamItem> {
  const decoder = new TextDecoder();
  const parser = createOpencodeV2SseParser();
  const convert = function* (items: OpencodeV2SseItem[]): Generator<OpencodeV2StreamItem> {
    for (const item of items) {
      if (item.kind === 'heartbeat') {
        yield item;
        continue;
      }
      const frame = parseOpencodeV2Frame(item.data);
      if (frame) yield { kind: 'frame', frame };
    }
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      yield* convert(parser.push(decoder.decode(value, { stream: true })));
    }
    yield* convert(parser.flush());
  } finally {
    await reader.cancel().catch(() => {});
  }
}
