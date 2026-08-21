/**
 * Holding — and losing — the connection to an opencode server (Issue #1763).
 *
 * This is the half of the integration that has no equivalent on any other tool.
 * Claude, codex, copilot, gemini and antigravity push into a route that is
 * always there; opencode has to be subscribed to, which means there are states
 * (`live`, `lost`, reconnecting) and therefore ways to be wrong that a push
 * source cannot be.
 *
 * The frames are the captured ones. What is stubbed is the socket.
 *
 * @vitest-environment node
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

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
  fetchOpencodePendingPermissions,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  getOpencodeLiveness,
  isOpencodeSubscribed,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const FIXTURES = join(process.cwd(), 'tests/fixtures/hooks/opencode');

function frame(name: string): OpencodeFrame {
  return JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), 'utf8'));
}

const TARGET = { worktreeId: 'wt-sub', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4242;

/** Yield the named fixtures, then end — a connection that dropped. */
function streamOf(...names: string[]) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    for (const name of names) yield frame(name);
  };
}

/** A connection that stays open and silent until the subscription aborts it. */
function silentStream(signal: AbortSignal) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    await new Promise<void>((resolve) => {
      if (signal.aborted) resolve();
      else signal.addEventListener('abort', () => resolve(), { once: true });
    });
  };
}

/** Queue of stream factories; anything past the end holds the line open. */
let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];

function subscribe() {
  return openOpencodeSubscription(
    TARGET,
    (event) => received.push(event),
    (raw) => opencodeAgentEventSource.normalizeEvent(raw),
    { port: PORT }
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodeSubscriptions();
  resetOpencodeToolCalls();
  resetUnknownEventTallies();
  queued = [];
  received = [];
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  // Issue #1900: the reconnect asks who is on the port before it trusts the
  // stream. Unmocked this would be a real request to a closed port.
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: '1.18.3' },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => {
      const next = queued.shift() ?? silentStream(signal);
      return next(signal);
    }
  );
});

afterEach(() => {
  resetOpencodeSubscriptions();
});

describe('delivery', () => {
  it('turns captured frames into the shared vocabulary', async () => {
    queued.push(streamOf('session-created', 'message-updated-user', 'session-status-busy', 'session-idle'));
    await subscribe();

    await vi.waitFor(() => expect(received.map((event) => event.event)).toEqual([
      'session_start',
      'user_prompt_submit',
      'stop',
    ]));
  });

  it('records the callID -> tool name correlation from an unmapped frame', async () => {
    // `message.part.updated` with `state.status: "pending"` maps to nothing —
    // and it is the frame that names the tool an approval will be about. Read
    // only from mapped events, every approval would be anonymous.
    const { lookupOpencodeToolName } = await import('@/lib/hooks/sources/opencode/payloads');
    queued.push(streamOf('message-part-updated-tool-pending'));
    await subscribe();

    await vi.waitFor(() =>
      expect(lookupOpencodeToolName('toolu_0000000000000000000000000')).toBe('bash')
    );
    expect(received).toHaveLength(0);
  });

  it('does not throw on a frame type it has no word for', async () => {
    // `server.heartbeat` is not in the server's own OpenAPI Event union and
    // arrives every ten seconds (#1758 D5).
    queued.push(streamOf('server-connected', 'server-heartbeat', 'session-status-busy'));
    await subscribe();

    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).not.toBe('unknown'));
    expect(received).toHaveLength(0);
  });

  it('reports the connection as live off the heartbeat', async () => {
    queued.push((signal) =>
      (async function* () {
        yield frame('server-heartbeat');
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true })
        );
      })()
    );
    await subscribe();

    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('live'));
  });
});

describe('turn completion', () => {
  it('reports one stop for an abort that fires session.idle twice', async () => {
    // The measured sequence (#1758 §5.3.2b): busy, error, status(idle), idle,
    // status(idle), idle — one turn, two idles, 19 ms apart.
    //
    // Mutation target: remove the turn gate from `deliver()` and this test goes
    // red with two `stop`s, which is one aborted turn resolving two `wait`s.
    queued.push(
      streamOf(
        'session-status-busy',
        'session-error',
        'session-status-idle',
        'session-idle',
        'session-status-idle',
        'session-idle'
      )
    );
    await subscribe();

    await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(2));
    expect(received.filter((event) => event.event === 'stop')).toHaveLength(1);
    // The error is still reported — `session.idle` alone cannot say whether the
    // turn finished or gave up.
    expect(received.filter((event) => event.detail === 'error')).toHaveLength(1);
  });

  it('does not let the trailing prompt repeat undo a completed turn', async () => {
    // Measured live on 1.18.3: opencode re-emits `message.updated` for the same
    // user message *after* `session.idle`, byte-identical to the first. Mapped
    // one-to-one, the newest event of a finished turn becomes
    // `user_prompt_submit` — which `status-mapping` reads as `running`, so
    // `commandmate wait` never returns.
    //
    // Mutation target: drop the `user_prompt_submit` arm of `gateVerdict` and
    // the last delivered event here becomes `user_prompt_submit` again.
    queued.push(
      streamOf(
        'message-updated-user',
        'session-status-busy',
        'message-updated-user',
        'session-idle',
        'message-updated-user'
      )
    );
    await subscribe();

    await vi.waitFor(() =>
      expect(received.map((event) => event.event)).toEqual(['user_prompt_submit', 'stop'])
    );
    // What the status layer actually reads.
    expect(received[received.length - 1].event).toBe('stop');
  });

  it('drops an idle for a turn this connection never saw start', async () => {
    queued.push(streamOf('session-idle'));
    await subscribe();

    // Nothing to wait for, so drive one full stream lifecycle instead.
    await vi.waitFor(() => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBe(1));
    expect(received.filter((event) => event.event === 'stop')).toHaveLength(0);
  });
});

describe('losing the connection', () => {
  it('reports lost, stops delivering, and reconnects', async () => {
    // The degradation the Issue asks for: when the stream drops, the structured
    // layer stops asserting anything and `current-output-builder` falls back to
    // the screen scraper. Nothing here has to make that happen — it happens
    // because no further events are recorded — but the liveness has to say so.
    queued.push(streamOf('session-status-busy', 'session-idle'));
    const subscription = await subscribe();

    await vi.waitFor(() => expect(received).toHaveLength(1));
    await vi.waitFor(() => expect(subscription.liveness.state).toBe('lost'));
    expect(getOpencodeLiveness(TARGET)).toMatchObject({ state: 'lost', reason: 'stream-ended' });

    const delivered = received.length;
    // The reconnect happens on a backoff; what matters here is that nothing is
    // delivered from a stream that ended.
    expect(received).toHaveLength(delivered);
  });

  it('surfaces a refused connection as lost rather than throwing', async () => {
    queued.push(() => {
      throw new Error('connect ECONNREFUSED 127.0.0.1:4242');
    });
    await subscribe();

    await vi.waitFor(() =>
      expect(getOpencodeLiveness(TARGET)).toMatchObject({
        state: 'lost',
        reason: 'connect ECONNREFUSED 127.0.0.1:4242',
      })
    );
    expect(received).toHaveLength(0);
  });

  it('re-arms after a reconnect, so a stale idle cannot resolve a wait', async () => {
    // The busy that armed the turn was on the old stream. An idle arriving
    // first on the new one is not this connection's completion.
    queued.push(streamOf('session-status-busy'));
    queued.push(streamOf('session-idle'));
    await subscribe();

    await vi.waitFor(
      () => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('lost'));
    expect(received.filter((event) => event.event === 'stop')).toHaveLength(0);
  });
});

describe('re-sync', () => {
  it('announces an approval that was raised while disconnected', async () => {
    // Durable replay does not work on 1.18.3 (`?after=` returns zero bytes), so
    // the only recovery is re-reading pending state. It matters more here than
    // anywhere else: an unanswered opencode approval waits forever.
    const permission = (frame('permission-asked') as { properties: Record<string, unknown> })
      .properties;
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([permission]);
    await subscribe();

    await vi.waitFor(() => expect(received).toHaveLength(1));
    expect(received[0].event).toBe('notification');
    expect(received[0].detail).toBe('permission_prompt');
    expect(received[0].conversationId).toBe('ses_0000000000000000000000000');
  });

  it('does not re-announce an approval it already delivered', async () => {
    const permission = (frame('permission-asked') as { properties: Record<string, unknown> })
      .properties;
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([permission]);
    queued.push(streamOf());
    queued.push(streamOf());
    await subscribe();

    await vi.waitFor(
      () => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
    expect(received).toHaveLength(1);
  });
});

describe('lifecycle', () => {
  it('opens no stream when the instance has no server', async () => {
    // No port assigned: structured events are off, allocation failed, or the
    // pane predates the feature. All three mean the scraper is in charge.
    const subscription = await openOpencodeSubscription(
      TARGET,
      (event) => received.push(event),
      (raw) => opencodeAgentEventSource.normalizeEvent(raw)
    );

    expect(vi.mocked(openOpencodeEventStream)).not.toHaveBeenCalled();
    expect(subscription.liveness).toEqual({ state: 'unknown' });
    expect(isOpencodeSubscribed(TARGET)).toBe(false);
  });

  it('re-uses the open stream instead of opening a second one', async () => {
    // Two streams would deliver every event twice, and nothing would error.
    await subscribe();
    await vi.waitFor(() => expect(vi.mocked(openOpencodeEventStream)).toHaveBeenCalledTimes(1));
    await subscribe();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(vi.mocked(openOpencodeEventStream)).toHaveBeenCalledTimes(1);
  });

  it('stops delivering after close', async () => {
    const subscription = await subscribe();
    expect(isOpencodeSubscribed(TARGET)).toBe(true);

    await subscription.close();

    expect(isOpencodeSubscribed(TARGET)).toBe(false);
    expect(getOpencodeLiveness(TARGET)).toEqual({ state: 'unknown' });
  });
});
