/**
 * Surviving a reconnect, a sub-agent, and a squatter (Issue #1900).
 *
 * Five defects in the opencode subscription, all of them about a moment when
 * the connection or the port is not what it was. What they share is that none
 * of them produces an error anywhere: a lost `stop` reads as a session still
 * working, a sub-agent's `stop` reads as one that finished, and a port hijacked
 * off a wildcard listener reads as a port that was free.
 *
 * The frames are the captured ones wherever a captured one exists. What is
 * stubbed is the socket — except in the port section, which is about real
 * sockets and would assert nothing without them.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'net';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
  fetchOpencodeSessionStatuses,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  isOpencodeSubscribed,
  openOpencodeSubscription,
  resetOpencodeSubscriptions,
  waitUnlessAborted,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { createTurnGate } from '@/lib/hooks/sources/opencode/turn-gate';
import {
  isPortFree,
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { attachOpencodeEventStream } from '@/lib/hooks/sources/opencode/runtime';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const TARGET = { worktreeId: 'wt-1900', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4271;
const VERSION = '1.18.21';

/** The session the human is waiting on. */
const PARENT = 'ses_parent0000000000000000';
/** A `task` sub-agent's session, which has a turn of its own. */
const CHILD = 'ses_child00000000000000000';

function busyFrame(sessionID: string): OpencodeFrame {
  return { id: `evt_busy_${sessionID}`, type: 'session.status', properties: { sessionID, status: { type: 'busy' } } };
}

function idleFrame(sessionID: string): OpencodeFrame {
  return { id: `evt_idle_${sessionID}`, type: 'session.idle', properties: { sessionID } };
}

/** `session.updated` for a sub-agent — the frame that carries `parentID`. */
function childDeclarationFrame(sessionID: string, parentID: string): OpencodeFrame {
  return {
    id: `evt_created_${sessionID}`,
    type: 'session.updated',
    properties: { sessionID, info: { id: sessionID, parentID, title: 'sub-agent' } },
  };
}

/** Yield these frames, then end — a connection that dropped. */
function streamOf(...frames: OpencodeFrame[]) {
  return async function* (): AsyncGenerator<OpencodeFrame> {
    for (const frame of frames) yield frame;
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

let queued: Array<(signal: AbortSignal) => AsyncGenerator<OpencodeFrame>>;
let received: NormalizedAgentEvent[];
let sandbox: string;
let portFile: string;
const listeners: Server[] = [];

/** Subscribe the way production does — through the source, so the declared
 *  `capabilities.resync` is the one in play. */
function subscribeThroughSource() {
  return opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));
}

const stopEvents = (): NormalizedAgentEvent[] => received.filter((event) => event.event === 'stop');

beforeAll(() => {
  sandbox = makeTempDir('opencode-1900-');
  portFile = join(sandbox, 'opencode-ports.json');
});

afterAll(() => {
  removeTempDir(sandbox);
});

beforeEach(() => {
  vi.clearAllMocks();
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
  resetOpencodeToolCalls();
  resetUnknownEventTallies();
  queued = [];
  received = [];
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  if (existsSync(portFile)) writeFileSync(portFile, '{}\n');
  rememberOpencodePort(TARGET, PORT, '/tmp/wt-1900');
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({});
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: VERSION },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => {
      const next = queued.shift() ?? silentStream(signal);
      return next(signal);
    }
  );
});

afterEach(async () => {
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
  vi.unstubAllEnvs();
  await Promise.all(listeners.splice(0).map((server) => new Promise((r) => server.close(r))));
});

// =============================================================================
// Item 1 — a reconnect that lands mid-turn
// =============================================================================

describe('recovering the turn a reconnect interrupted', () => {
  it('re-arms a session the server still calls busy', async () => {
    // The reported failure: the watchdog trips 30 s into a turn, the reconnect
    // resets the gate, and the `session.idle` that eventually arrives is
    // dropped as `never-armed`. The instance then reads `running` off its last
    // `post_tool_use` for the whole 30-minute staleness bound.
    vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({ [PARENT]: 'busy' });
    queued.push(streamOf(busyFrame(PARENT)));
    queued.push(streamOf(idleFrame(PARENT)));

    await subscribeThroughSource();

    await vi.waitFor(() => expect(stopEvents()).toHaveLength(1), { timeout: 4000 });
    expect(stopEvents()[0].conversationId).toBe(PARENT);
  });

  it('synthesises the stop of a turn that finished off-stream', async () => {
    // Nothing arrives on the new stream at all — the turn ended while the
    // connection was down. `GET /session/status` is the only thing that can
    // still say so, because `?after=<seq>` returns zero bytes on this server.
    vi.mocked(fetchOpencodeSessionStatuses)
      .mockResolvedValueOnce({ [PARENT]: 'busy' })
      .mockResolvedValue({ [PARENT]: 'idle' });
    queued.push(streamOf(busyFrame(PARENT)));

    await subscribeThroughSource();

    await vi.waitFor(() => expect(stopEvents()).toHaveLength(1), { timeout: 4000 });
    expect(stopEvents()[0].conversationId).toBe(PARENT);
  });

  it('will not invent a stop for a session the status reply does not mention', async () => {
    // Absence is not idle. A session the server has forgotten says nothing
    // about whether its turn ended, and guessing there resolves a `wait` on
    // silence — the exact failure this whole gate exists to prevent.
    vi.mocked(fetchOpencodeSessionStatuses)
      .mockResolvedValueOnce({ [PARENT]: 'busy' })
      .mockResolvedValue({});
    queued.push(streamOf(busyFrame(PARENT)));
    queued.push(streamOf());

    await subscribeThroughSource();

    await vi.waitFor(
      () => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
    expect(stopEvents()).toHaveLength(0);
  });

  it('does none of it for a source that declares no way to re-sync', async () => {
    // The capability is the switch (#1924 §4 D3), not the tool id. This is the
    // pre-#1900 behaviour, and it is what flipping opencode's declared
    // `resync` to `'none'` restores — see the mutation note on `./source`.
    vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({ [PARENT]: 'idle' });
    queued.push(streamOf(busyFrame(PARENT)));
    queued.push(streamOf());

    await openOpencodeSubscription(
      TARGET,
      (event) => received.push(event),
      (raw) => opencodeAgentEventSource.normalizeEvent(raw),
      { port: PORT }
    );

    await vi.waitFor(
      () => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
    expect(vi.mocked(fetchOpencodeSessionStatuses)).not.toHaveBeenCalled();
    expect(stopEvents()).toHaveLength(0);
  });
});

// =============================================================================
// Item 1 / DR4-004 — health before trust (§13.2 S5)
// =============================================================================

describe('trusting the port', () => {
  it('stops watching a port whose server is a different process', async () => {
    // The port is loopback and unauthenticated. If the pane died and something
    // else took 4271, one `{"ses_…":{"type":"idle"}}` would be enough to close
    // a `wait` — so the version is checked before either the stream or the
    // status poll is believed.
    vi.mocked(probeOpencodeHealth)
      .mockResolvedValueOnce({ kind: 'healthy', health: { healthy: true, version: VERSION } })
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: '9.9.9' } });
    vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({ [PARENT]: 'idle' });
    queued.push(streamOf(busyFrame(PARENT)));

    await subscribeThroughSource();

    await vi.waitFor(() => expect(isOpencodeSubscribed(TARGET)).toBe(false), { timeout: 4000 });
    expect(vi.mocked(openOpencodeEventStream)).toHaveBeenCalledTimes(1);
    expect(stopEvents()).toHaveLength(0);
  });

  it('treats a version it cannot read as no evidence either way', async () => {
    // `version` is optional in the health document. A missing field is not a
    // mismatch, and refusing to reconnect on it would strand every server that
    // stops publishing one.
    vi.mocked(probeOpencodeHealth).mockResolvedValue({
      kind: 'healthy',
      health: { healthy: true, version: null },
    });
    queued.push(streamOf());

    await subscribeThroughSource();

    await vi.waitFor(
      () => expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(2),
      { timeout: 4000 }
    );
    expect(isOpencodeSubscribed(TARGET)).toBe(true);
  });
});

// =============================================================================
// Item 2 — whose completion counts
// =============================================================================

describe('the turn gate, on a server carrying more than one session', () => {
  it('does not let a sub-agent idle close the session the human is waiting on', () => {
    const gate = createTurnGate();
    gate.observe('session.status', busyFrame(PARENT));
    gate.observe('session.status', busyFrame(CHILD));

    expect(gate.observe('session.idle', idleFrame(CHILD))).toEqual({
      kind: 'suppressed',
      sessionId: CHILD,
      reason: 'foreign-session',
    });
    expect(gate.observe('session.idle', idleFrame(PARENT))).toEqual({
      kind: 'completed',
      sessionId: PARENT,
    });
  });

  it('never gives the title to a session that declared a parent', () => {
    // Even when the child is the *first* thing this connection sees busy —
    // which is what a reconnect landing inside a `task` call looks like.
    const gate = createTurnGate();
    gate.observe('session.updated', childDeclarationFrame(CHILD, PARENT));
    gate.observe('session.status', busyFrame(CHILD));

    expect(gate.primarySession()).toBeNull();
    expect(gate.observe('session.idle', idleFrame(CHILD))).toEqual({
      kind: 'suppressed',
      sessionId: CHILD,
      reason: 'foreign-session',
    });
  });

  it('takes the title back off a session that turns out to be a child', () => {
    const gate = createTurnGate();
    gate.observe('session.status', busyFrame(CHILD));
    expect(gate.primarySession()).toBe(CHILD);

    gate.observe('session.updated', childDeclarationFrame(CHILD, PARENT));
    expect(gate.primarySession()).toBeNull();
  });

  it('lifts the rule once the instance is no longer working', () => {
    // The bound on being wrong. A mis-inferred primary must not be able to
    // swallow completions forever: with no turn open there is nothing to cut
    // short, so a stray idle is delivered and the worst case is a turn closed
    // late rather than one that never closes.
    const gate = createTurnGate();
    gate.observe('session.status', busyFrame(PARENT));
    gate.observe('session.idle', idleFrame(PARENT));

    gate.observe('session.status', busyFrame('ses_second000000000000000'));
    expect(gate.primarySession()).toBe('ses_second000000000000000');
    expect(gate.observe('session.idle', { properties: { sessionID: 'ses_second000000000000000' } }))
      .toEqual({ kind: 'completed', sessionId: 'ses_second000000000000000' });
  });

  it('forgets the primary on reset but not which sessions are children', () => {
    const gate = createTurnGate();
    gate.observe('session.updated', childDeclarationFrame(CHILD, PARENT));
    gate.observe('session.status', busyFrame(PARENT));
    gate.reset();

    expect(gate.primarySession()).toBeNull();
    expect(gate.armedSessions()).toEqual([]);
    // Parentage is permanent, and the frame that declared it may never come
    // again on the new connection.
    gate.observe('session.status', busyFrame(CHILD));
    expect(gate.primarySession()).toBeNull();
  });

  it('arms from the status poll the way it arms from a frame', () => {
    const gate = createTurnGate();
    gate.arm(PARENT);

    expect(gate.isArmed(PARENT)).toBe(true);
    expect(gate.armedSessions()).toEqual([PARENT]);
    expect(gate.primarySession()).toBe(PARENT);
  });

  it('delivers no stop for a sub-agent, end to end', async () => {
    queued.push(
      streamOf(
        busyFrame(PARENT),
        childDeclarationFrame(CHILD, PARENT),
        busyFrame(CHILD),
        idleFrame(CHILD)
      )
    );

    await subscribeThroughSource();

    // The sub-agent's turn produced nothing; the parent's produces the stop.
    await vi.waitFor(() =>
      expect(vi.mocked(openOpencodeEventStream).mock.calls.length).toBeGreaterThanOrEqual(1)
    );
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(stopEvents()).toHaveLength(0);
  });
});

// =============================================================================
// Item 3 — a port that only looks free
// =============================================================================

describe('deciding a port is free', () => {
  /** Occupy a port on one address for the duration of one test. */
  function occupy(port: number, host: string): Promise<void> {
    return new Promise((resolve, reject) => {
      const server = createServer();
      server.once('error', reject);
      server.listen(port, host, () => {
        listeners.push(server);
        resolve();
      });
    });
  }

  it('sees a server bound to every interface', async () => {
    // Measured on Darwin 25.6.0: Node sets SO_REUSEADDR on every listener, and
    // on macOS/BSD that lets a bind to 127.0.0.1 succeed while another process
    // holds 0.0.0.0 on the same port. The pre-#1900 probe therefore called
    // 4200 — Angular's default, inside this range — free, and opencode then
    // won `http://localhost:4200` off the dev server that was serving it.
    await occupy(4288, '0.0.0.0');
    expect(await isPortFree(4288)).toBe(false);
  });

  it('still sees a server bound to loopback alone', async () => {
    await occupy(4289, '127.0.0.1');
    expect(await isPortFree(4289)).toBe(false);
  });

  it('says yes to a port nobody holds', async () => {
    expect(await isPortFree(4290)).toBe(true);
  });
});

// =============================================================================
// Item 4 — an attach that is allowed to ask twice
// =============================================================================

describe('attaching to a server that is still coming up', () => {
  it('retries the health probe instead of writing the session off', async () => {
    // One shot was a decision that lasted the whole session: nothing
    // re-attaches a pane that is already running, so a single miss meant
    // scraper-only until the pane was restarted.
    vi.mocked(probeOpencodeHealth)
      .mockResolvedValueOnce({ kind: 'refused', error: 'connect ECONNREFUSED' })
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: VERSION } });

    expect(await attachOpencodeEventStream(TARGET)).toBe(true);
    expect(vi.mocked(probeOpencodeHealth).mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it('does not retry a server that answered and refused', async () => {
    // `OPENCODE_SERVER_PASSWORD` in the pane's environment makes every request
    // a 401. Something is there; it will say 401 again in half a second.
    vi.mocked(probeOpencodeHealth).mockResolvedValue({ kind: 'rejected', status: 401 });

    expect(await attachOpencodeEventStream(TARGET)).toBe(false);
    expect(vi.mocked(probeOpencodeHealth)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(openOpencodeEventStream)).not.toHaveBeenCalled();
  });
});

// =============================================================================
// Item 5 — the order of the reconnect, and a backoff that can be cut short
// =============================================================================

describe('the reconnect sequence', () => {
  it('subscribes before it re-reads what is pending', async () => {
    // Re-reading first left a window with no watcher: an approval raised
    // between `GET /permission` and the `/event` subscription was on neither
    // side, and an unanswered opencode approval waits forever.
    await subscribeThroughSource();

    await vi.waitFor(() =>
      expect(vi.mocked(fetchOpencodePendingPermissions)).toHaveBeenCalled()
    );
    expect(vi.mocked(openOpencodeEventStream).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(fetchOpencodePendingPermissions).mock.invocationCallOrder[0]
    );
  });
});

describe('the backoff', () => {
  it('is already over when the signal aborted before it started', async () => {
    // The ordinary case, and the one the old code got wrong: the abort that
    // ended the read happens *before* the sleep, and
    // `addEventListener('abort')` on an already-aborted signal never fires.
    const controller = new AbortController();
    controller.abort();

    const started = Date.now();
    await waitUnlessAborted(30_000, controller.signal);
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('ends the moment the subscription is torn down', async () => {
    const controller = new AbortController();
    const started = Date.now();
    const waited = waitUnlessAborted(30_000, controller.signal);
    setTimeout(() => controller.abort(), 10);

    await waited;
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it('leaves no listener behind on a signal that outlives it', async () => {
    // The lifetime signal is one object for the whole session, so a listener
    // per reconnect is a `MaxListenersExceededWarning` waiting to happen.
    let added = 0;
    let removed = 0;
    const signal = {
      aborted: false,
      addEventListener: () => {
        added += 1;
      },
      removeEventListener: () => {
        removed += 1;
      },
    } as unknown as AbortSignal;

    await waitUnlessAborted(1, signal);

    expect(added).toBe(1);
    expect(removed).toBe(1);
  });
});
