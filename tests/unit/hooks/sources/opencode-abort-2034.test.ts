/**
 * Issue #2034: aborting an opencode turn over the server, and knowing it worked.
 *
 * ## What was measured, and where these frames come from
 *
 * Re-measured for this Issue on **opencode 1.18.22** (the version installed
 * here; #1758 measured 1.18.3) in an isolated HOME — `opencode serve` on
 * 127.0.0.1:4298, LM Studio as the provider, `POST /session/:id/prompt_async`,
 * then `POST /session/:id/abort` six seconds into the generation:
 *
 * ```
 * HTTP/1.1 200 OK            <- the abort's reply
 * Content-Type: application/json
 * Content-Length: 4
 * true
 *
 * 10:17:20.058  session.status  busy
 * 10:17:25.946  session.error   MessageAbortedError
 * 10:17:25.946  session.status  idle
 * 10:17:25.946  session.idle          <- 1st
 * 10:17:25.969  session.idle          <- 2nd, 23 ms later
 * 10:17:29.002  session.idle          <- a SECOND abort, on the now-idle session
 * ```
 *
 * Three facts fall out, and each is asserted below:
 *
 *  - **`session.idle` really does arrive twice** for an abort — 23 ms here,
 *    19 ms on 1.18.3 (#1758 §5.3.2). The gate absorbs the repeat for
 *    publication; the idle *watch* absorbs it by settling once and
 *    unregistering.
 *  - **`200 true` is not "a turn was stopped".** Aborting the same session
 *    again while it was already idle answered `200 true` as well. Only the
 *    frame confirms.
 *  - **The frame can be on the wire before the reply is.** So the watch is
 *    armed before the request, which is what the ordering test pins.
 *
 * The frames are inline rather than in `tests/fixtures/`: they are this Issue's
 * own capture and the transcript above is what gives them their meaning.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    probeOpencodeHealth: vi.fn(),
    openOpencodeEventStream: vi.fn(),
  };
});

import {
  abortOpencodeSession,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  getOpencodeLiveness,
  getOpencodePrimarySession,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
  watchOpencodeSessionIdle,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const TARGET = { worktreeId: 'wt-2034', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4298;
/** The session id from the live capture. */
const SESSION = 'ses_fc981bbfbffehcj99HRR4GwkkC';

const busy = (sessionID = SESSION): OpencodeFrame => ({
  id: 'evt_busy',
  type: 'session.status',
  properties: { sessionID, status: { type: 'busy' } },
});

const idle = (sessionID = SESSION, id = 'evt_idle'): OpencodeFrame => ({
  id,
  type: 'session.idle',
  properties: { sessionID },
});

const abortError = (sessionID = SESSION): OpencodeFrame => ({
  id: 'evt_err',
  type: 'session.error',
  properties: { sessionID, error: { name: 'MessageAbortedError', data: { message: 'Aborted' } } },
});

// ---------------------------------------------------------------------------
// `abortOpencodeSession` — the request itself
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

/** Answer one request with a JSON body, the way a real server labels it. */
function stubJson(body: unknown, init: { ok?: boolean; status?: number; contentType?: string } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: init.ok ?? true,
    status: init.status ?? 200,
    headers: new Headers({ 'content-type': init.contentType ?? 'application/json' }),
    json: async () => body,
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return fetchMock;
}

describe('Issue #2034: abortOpencodeSession', () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('POSTs to the measured route on loopback, with redirects refused', async () => {
    const fetchMock = stubJson(true);

    expect(await abortOpencodeSession(PORT, SESSION)).toBe(true);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`http://127.0.0.1:${PORT}/session/${SESSION}/abort`);
    expect(init.method).toBe('POST');
    // Issue #1931: the port is the whole trust model, so a squatter answering
    // `302 Location: …` must not get to choose where this server asks next.
    expect(init.redirect).toBe('manual');
  });

  it('escapes a session id rather than pasting it into the path', async () => {
    const fetchMock = stubJson(true);

    await abortOpencodeSession(PORT, 'ses_../../global/health');

    const [url] = fetchMock.mock.calls[0] as [string];
    expect(url).toBe(`http://127.0.0.1:${PORT}/session/ses_..%2F..%2Fglobal%2Fhealth/abort`);
  });

  it('refuses a body that is not `true`', async () => {
    // The route's own schema (`GET /doc`, operationId `session.abort`) declares
    // a bare boolean. `false` is the server saying it did not take the request,
    // and it parses into a perfectly good body — so "not null" is not enough.
    stubJson(false);
    expect(await abortOpencodeSession(PORT, SESSION)).toBe(false);

    stubJson({ ok: true });
    expect(await abortOpencodeSession(PORT, SESSION)).toBe(false);
  });

  it('refuses an HTTP error and a body that is not JSON', async () => {
    stubJson(true, { ok: false, status: 404 });
    expect(await abortOpencodeSession(PORT, SESSION)).toBe(false);

    // Measured on 1.18.21 (#1931): an unknown route answers `200 text/html` —
    // the web UI's SPA shell. "The socket accepted me" is not "the route exists".
    stubJson(true, { contentType: 'text/html' });
    expect(await abortOpencodeSession(PORT, SESSION)).toBe(false);
  });

  it('never throws when nothing is listening', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    // The ordinary case: the pane exited. The interrupt still has a keyboard.
    await expect(abortOpencodeSession(PORT, SESSION)).resolves.toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The idle watch — confirming the turn actually ended
// ---------------------------------------------------------------------------

let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];
/** Frames pushed into the open stream from the test body. */
let push: (frame: OpencodeFrame) => void;

/** A connection that stays open and yields whatever the test pushes. */
function pushableStream(signal: AbortSignal) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    const pending: OpencodeFrame[] = [];
    let wake: (() => void) | null = null;
    push = (frame) => {
      pending.push(frame);
      wake?.();
    };
    for (;;) {
      while (pending.length > 0) yield pending.shift() as OpencodeFrame;
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
        signal.addEventListener('abort', () => resolve(), { once: true });
      });
      wake = null;
      if (signal.aborted && pending.length === 0) return;
    }
  };
}

function subscribe() {
  return openOpencodeSubscription(
    TARGET,
    (event) => received.push(event),
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT, resync: opencodeAgentEventSource.capabilities.resync }
  );
}

describe('Issue #2034: confirming an abort with `session.idle`', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    resetOpencodeSubscriptions();
    resetOpencodeToolCalls();
    resetUnknownEventTallies();
    queued = [];
    received = [];
    push = () => {};
    vi.mocked(probeOpencodeHealth).mockResolvedValue({
      kind: 'healthy',
      health: { healthy: true, version: '1.18.22' },
    });
    vi.mocked(openOpencodeEventStream).mockImplementation(
      async (_port: number, signal: AbortSignal) => {
        const next = queued.shift() ?? pushableStream(signal);
        return next(signal);
      }
    );
  });

  afterEach(() => {
    resetOpencodeSubscriptions();
  });

  /** Subscribe and put the captured session mid-turn, as `busy` does live. */
  async function subscribeBusy(): Promise<void> {
    await subscribe();
    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('live'));
    push(busy());
    await vi.waitFor(() => expect(getOpencodePrimarySession(TARGET)).toBe(SESSION));
  }

  it('names the session whose turn is the instance\'s turn', async () => {
    // What the abort is addressed to. Null before anything has been seen busy:
    // CommandMate does not know whose turn to end, and says so.
    expect(getOpencodePrimarySession(TARGET)).toBeNull();
    await subscribeBusy();
    expect(getOpencodePrimarySession(TARGET)).toBe(SESSION);
  });

  it('resolves on the first idle and leaves the 23 ms repeat with no waiter', async () => {
    await subscribeBusy();

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 5_000);
    // The live sequence, in order: the abort error and both idles.
    push(abortError());
    push(idle(SESSION, 'evt_idle_1'));

    await expect(watch.seen).resolves.toBe(true);

    // The second idle 23 ms later must not resolve anything a second time. A
    // fresh watch is what shows it landed nowhere: if the repeat had been
    // queued up for the old waiter, this one would be unaffected — so the real
    // assertion is that the FIRST watch settled once, which `resolves` above
    // already made, plus that a later idle is still observable for a new watch.
    const second = watchOpencodeSessionIdle(TARGET, SESSION, 5_000);
    push(idle(SESSION, 'evt_idle_2'));
    await expect(second.seen).resolves.toBe(true);

    // And the gate did its own half: exactly one `stop` was published for the
    // pair, which is the behaviour this watch must not contradict.
    await vi.waitFor(() =>
      expect(received.filter((event) => event.event === 'stop')).toHaveLength(1)
    );
  });

  it('ignores an idle for another session', async () => {
    await subscribeBusy();

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 60);
    // A sub-agent finishing is not this instance's turn ending (#1900).
    push(idle('ses_subagent', 'evt_idle_other'));

    await expect(watch.seen).resolves.toBe(false);
  });

  it('answers false when the wait runs out', async () => {
    await subscribeBusy();

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 30);
    await expect(watch.seen).resolves.toBe(false);
  });

  it('answers false, rather than hanging, when there is no subscription', async () => {
    const watch = watchOpencodeSessionIdle(
      { worktreeId: 'wt-nothing', cliToolId: 'opencode' },
      SESSION,
      5_000
    );
    await expect(watch.seen).resolves.toBe(false);
  });

  it('gives up when the subscription is torn down mid-wait', async () => {
    await subscribeBusy();

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 60_000);
    resetOpencodeSubscriptions();

    // Without this the interrupt would sit out its whole budget on a connection
    // that no longer exists before falling back to the keyboard.
    await expect(watch.seen).resolves.toBe(false);
  });

  it('cancel() settles it false and a later idle changes nothing', async () => {
    await subscribeBusy();

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 60_000);
    watch.cancel();
    watch.cancel(); // idempotent
    await expect(watch.seen).resolves.toBe(false);

    push(idle());
    await expect(watch.seen).resolves.toBe(false);
  });

  it('sees an idle the gate refuses to publish', async () => {
    // A stream that opened mid-turn: nothing armed the gate, so the idle is
    // `never-armed` and no `stop` goes out. It is still the answer to "did the
    // turn this abort targeted end?", which is why the watch reads the frame.
    await subscribe();
    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('live'));

    const watch = watchOpencodeSessionIdle(TARGET, SESSION, 5_000);
    push(idle());

    await expect(watch.seen).resolves.toBe(true);
    expect(received.filter((event) => event.event === 'stop')).toHaveLength(0);
  });
});
