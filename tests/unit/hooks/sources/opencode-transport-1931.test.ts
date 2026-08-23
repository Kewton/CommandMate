/**
 * The wire under the opencode trust boundary (Issue #1931, §10.4 / S13).
 *
 * Everything CommandMate believes about an opencode instance arrives over one
 * unauthenticated loopback port, and `isPortFree` is a bind-and-close check —
 * so the port can change hands between the moment it is written down and the
 * moment it is read. Issue #1900 put the *identity* check in (`/global/health`
 * plus a matching `version`). What it did not do is stop the transport itself
 * from being talked out of loopback, and that is what these tests hold down.
 *
 * Three properties, all of them measured against a real socket rather than a
 * stubbed `fetch`, because every one of them is about what the HTTP layer does
 * with a response — and a `vi.fn()` returning `{ok: true}` cannot follow a
 * redirect, which is the whole thing being prevented:
 *
 *  - **A 3xx is refused, not followed.** `fetch` defaults to
 *    `redirect: 'follow'`. A process that took the port and answers `302
 *    Location: http://<elsewhere>/…` would otherwise have CommandMate read the
 *    server identity, the pending approvals and — worst — `GET /session/status`
 *    off a host it never chose. The decoy server in each case answers
 *    *plausibly*, so a build without `redirect: 'manual'` does not merely leak a
 *    request: it gets a usable answer and acts on it.
 *  - **A response that is not the right media type is not read.** Measured on
 *    opencode 1.18.21: an unknown route answers **`200 text/html`** with the web
 *    UI's SPA shell, not a 404. "The socket accepted me" is therefore not "the
 *    route exists", and the `/event` case is the expensive one — an HTML page
 *    held open is a subscription that reports `live` and delivers nothing. Each
 *    stub below serves a *valid* body under the wrong `content-type`, so the
 *    assertions fail if the check is removed rather than passing on a parse
 *    error that would have happened anyway.
 *  - **One frame cannot be unbounded.** A sender with no frame boundary is
 *    memory exhaustion in a single socket.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'http';
import type { AddressInfo } from 'net';

// `vi.hoisted` so the mock exists by the time `vi.mock` is lifted above it.
const { mockLogger } = vi.hoisted(() => ({
  mockLogger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  },
}));
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

import {
  createSseParser,
  fetchOpencodePendingPermissions,
  fetchOpencodeSessionStatuses,
  MAX_OPENCODE_SESSION_STATUSES,
  MAX_OPENCODE_SSE_FRAME_CHARS,
  OPENCODE_EVENT_CONTENT_TYPE,
  OPENCODE_FETCH_REDIRECT,
  OPENCODE_JSON_CONTENT_TYPE,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';

/** The version a hijacker would like CommandMate to accept as its own. */
const SQUATTER_VERSION = '9.9.9';
/** A session id the forged `/session/status` claims is idle — i.e. `wait` exit 0. */
const FORGED_SESSION = 'ses_forged000000000000000';

const servers: Server[] = [];

/** Listen on an ephemeral loopback port — never a fixed one, so parallel
 *  worktrees running this suite at once cannot collide. */
async function listen(handler: (url: string, res: import('http').ServerResponse) => void): Promise<number> {
  const server = createServer((req, res) => handler(req.url ?? '/', res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** Answers every route the client knows, plausibly, and counts what it was asked. */
async function startDecoy(): Promise<{ port: number; requests: string[] }> {
  const requests: string[] = [];
  const port = await listen((url, res) => {
    requests.push(url);
    if (url.startsWith('/event')) {
      res.writeHead(200, { 'Content-Type': OPENCODE_EVENT_CONTENT_TYPE });
      res.write(`data: ${JSON.stringify({ id: 'evt_decoy', type: 'session.idle', properties: { sessionID: FORGED_SESSION } })}\n\n`);
      return;
    }
    const body = url.startsWith('/permission')
      ? JSON.stringify([{ id: 'per_decoy', title: 'rm -rf /' }])
      : url.startsWith('/session/status')
        ? JSON.stringify({ [FORGED_SESSION]: { type: 'idle' } })
        : JSON.stringify({ healthy: true, version: SQUATTER_VERSION });
    res.writeHead(200, { 'Content-Type': OPENCODE_JSON_CONTENT_TYPE });
    res.end(body);
  });
  return { port, requests };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))
  );
});

// =============================================================================
// S4 — a redirect is refused, not followed
// =============================================================================

describe('a port that answers with a redirect', () => {
  /** The hijacker: 302 everything to the decoy, preserving the path. */
  async function startRedirector(decoyPort: number): Promise<number> {
    return listen((url, res) => {
      res.writeHead(302, { Location: `http://127.0.0.1:${decoyPort}${url}` });
      res.end();
    });
  }

  it('is declared, and cannot be argued out of by a call site', () => {
    // The constant is the single point of regression: every request in the
    // module goes through the one helper that spreads it *after* the caller's
    // init, so no call site can put `follow` back.
    expect(OPENCODE_FETCH_REDIRECT).toBe('manual');
  });

  it('is not believed as an identity, and the redirect target is never asked', async () => {
    const decoy = await startDecoy();
    const port = await startRedirector(decoy.port);

    const outcome = await probeOpencodeHealth(port);

    // `rejected`, not `refused`: a process that answers a redirect will answer
    // one again, so this must not be retried on the way back up.
    expect(outcome).toEqual({ kind: 'rejected', status: 302 });
    expect(decoy.requests).toEqual([]);
  });

  it('does not hand the approval queue to whoever the redirect names', async () => {
    // The pending list is what Auto-Yes adjudicates. Reading it off an
    // unrelated host means answering *its* prompts on the operator's behalf.
    const decoy = await startDecoy();
    const port = await startRedirector(decoy.port);

    expect(await fetchOpencodePendingPermissions(port)).toEqual([]);
    expect(decoy.requests).toEqual([]);
  });

  it('does not take a turn boundary from whoever the redirect names', async () => {
    // The forgery that matters most: one `{"ses_…":{"type":"idle"}}` is enough
    // to close a `commandmate wait` at exit 0.
    const decoy = await startDecoy();
    const port = await startRedirector(decoy.port);

    expect(await fetchOpencodeSessionStatuses(port)).toBeNull();
    expect(decoy.requests).toEqual([]);
  });

  it('does not subscribe to whoever the redirect names', async () => {
    const decoy = await startDecoy();
    const port = await startRedirector(decoy.port);
    const controller = new AbortController();

    await expect(openOpencodeEventStream(port, controller.signal)).rejects.toThrow(/302/);
    expect(decoy.requests).toEqual([]);
    controller.abort();
  });
});

// =============================================================================
// §10.4 — the media type has to be the one this call can read
// =============================================================================

describe('a port that answers the right bytes under the wrong content-type', () => {
  /** 200, a body that would parse, and the SPA shell's `text/html` on it. */
  async function startMislabelled(): Promise<number> {
    return listen((url, res) => {
      if (url.startsWith('/event')) {
        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.write(`data: ${JSON.stringify({ id: 'evt_html', type: 'session.idle', properties: { sessionID: FORGED_SESSION } })}\n\n`);
        return;
      }
      const body = url.startsWith('/session/status')
        ? JSON.stringify({ [FORGED_SESSION]: { type: 'idle' } })
        : JSON.stringify({ healthy: true, version: SQUATTER_VERSION });
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(body);
    });
  }

  it('is not a healthy opencode server', async () => {
    const port = await startMislabelled();
    // Status 0 is this module's "something answered and it is not opencode",
    // as distinct from an HTTP error it could name.
    expect(await probeOpencodeHealth(port)).toEqual({ kind: 'rejected', status: 0 });
  });

  it('cannot close a turn', async () => {
    const port = await startMislabelled();
    expect(await fetchOpencodeSessionStatuses(port)).toBeNull();
  });

  it('cannot be subscribed to, however open the socket stays', async () => {
    // Without the check this resolves: the body is well-formed SSE and the
    // subscription would report itself `live` on an HTML page.
    const port = await startMislabelled();
    const controller = new AbortController();

    await expect(openOpencodeEventStream(port, controller.signal)).rejects.toThrow(/text\/html/);
    controller.abort();
  });

  it('still accepts the type with parameters on it', async () => {
    // `application/json; charset=utf-8` is legal even though 1.18.21 sends the
    // bare type. Rejecting it would be a hardening that breaks a live server.
    const port = await listen((_url, res) => {
      res.writeHead(200, { 'Content-Type': 'Application/JSON; charset=utf-8' });
      res.end(JSON.stringify({ healthy: true, version: '1.18.21' }));
    });

    expect(await probeOpencodeHealth(port)).toEqual({
      kind: 'healthy',
      health: { healthy: true, version: '1.18.21' },
    });
  });
});

// =============================================================================
// §10.4 — one frame is bounded
// =============================================================================

describe('the SSE frame cap', () => {
  const overCap = 'x'.repeat(MAX_OPENCODE_SSE_FRAME_CHARS + 1);

  it('is a named bound, not a literal at the call site', () => {
    expect(MAX_OPENCODE_SSE_FRAME_CHARS).toBe(256 * 1024);
  });

  it('drops an oversized frame, counts it, and keeps parsing the next one', () => {
    const parser = createSseParser();
    const good = JSON.stringify({ id: 'evt_ok', type: 'session.idle' });

    expect(parser.push(`data: ${overCap}\n\n`)).toEqual([]);
    expect(parser.oversizedFrames()).toBe(1);
    // The stream is not abandoned: the very next frame comes through.
    expect(parser.push(`data: ${good}\n\n`)).toEqual([good]);
    expect(parser.oversizedFrames()).toBe(1);
  });

  it('drops the rest of an oversized frame rather than emitting its tail', () => {
    // A multi-line `data:` frame that goes over the cap on its first line must
    // not come back as a truncated frame — a half-frame parses into a document
    // with fields missing, which is worse than no frame at all.
    const parser = createSseParser();
    expect(parser.push(`data: ${overCap}\ndata: {"id":"evt_tail"}\n\n`)).toEqual([]);
    expect(parser.oversizedFrames()).toBe(1);
    expect(parser.flush()).toEqual([]);
  });

  it('bounds a sender that never sends a frame boundary at all', () => {
    // The hostile case: no newline, ever. Nothing in the line loop can bound
    // this, because there is no line to consume — every byte just accumulates.
    const parser = createSseParser();
    expect(parser.push(overCap)).toEqual([]);
    expect(parser.oversizedFrames()).toBe(1);

    // And it recovers at the next boundary rather than staying poisoned.
    const good = JSON.stringify({ id: 'evt_after', type: 'session.idle' });
    expect(parser.push(`tail-of-the-garbage\n\ndata: ${good}\n\n`)).toEqual([good]);
  });

  it('reports the drop through the stream, so an operator can see it', async () => {
    const good = JSON.stringify({ id: 'evt_ok', type: 'session.idle', properties: {} });
    const port = await listen((_url, res) => {
      res.writeHead(200, { 'Content-Type': OPENCODE_EVENT_CONTENT_TYPE });
      res.write(`data: ${overCap}\n\n`);
      res.write(`data: ${good}\n\n`);
      res.end();
    });
    const controller = new AbortController();

    const frames: OpencodeFrame[] = [];
    for await (const frame of await openOpencodeEventStream(port, controller.signal)) {
      frames.push(frame);
    }
    controller.abort();

    expect(frames).toEqual([{ id: 'evt_ok', type: 'session.idle', properties: {} }]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'opencode-sse-frame-oversized',
      expect.objectContaining({ port, dropped: 1, limitChars: MAX_OPENCODE_SSE_FRAME_CHARS })
    );
  });
});

// =============================================================================
// DR4-009 — the other bounded read off a server CommandMate did not start
// =============================================================================

describe('the session-status cap', () => {
  it('is a named bound, not a literal in the loop', () => {
    expect(MAX_OPENCODE_SESSION_STATUSES).toBe(128);
  });

  it('reads up to the cap and reports the rest rather than dropping it silently', async () => {
    // One server's `opencode.db` is shared by every TUI with the same HOME and
    // project (#1758 §5.6.3), so the size of this document is not bounded by
    // this instance's own behaviour.
    const total = MAX_OPENCODE_SESSION_STATUSES + 7;
    const body = Object.fromEntries(
      Array.from({ length: total }, (_, i) => [
        `ses_${String(i).padStart(22, '0')}`,
        { type: 'idle' },
      ])
    );
    const port = await listen((_url, res) => {
      res.writeHead(200, { 'Content-Type': OPENCODE_JSON_CONTENT_TYPE });
      res.end(JSON.stringify(body));
    });

    const statuses = await fetchOpencodeSessionStatuses(port);

    expect(Object.keys(statuses ?? {})).toHaveLength(MAX_OPENCODE_SESSION_STATUSES);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'opencode-session-status-truncated',
      expect.objectContaining({
        port,
        kept: MAX_OPENCODE_SESSION_STATUSES,
        total,
        limit: MAX_OPENCODE_SESSION_STATUSES,
      })
    );
  });
});
