/**
 * What is actually reading an agent pane, and what says so (Issue #2054).
 *
 * Phase 4 gave every source a `liveness()` and a `probeActivity()` and gave
 * neither a caller. This suite is about the wiring that closed that: the fold
 * from a transport's `SourceLiveness` to the `kind` / `degradedReason` /
 * `liveness` triple both status surfaces publish, the tombstone that stops the
 * one interesting state from being deleted before anybody can read it, and the
 * post-attach activity probe.
 *
 * The expected values are **pinned against a live measurement**, not composed
 * here: `tests/fixtures/opencode-liveness-2054/live-probe.json` is what a real
 * opencode 1.18.22 on an isolated HOME published when its port was handed to
 * another process. See `docs/design/opencode-server-live-verification.md` §25.
 *
 * @vitest-environment node
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

vi.mock('@/lib/hooks/sources/opencode/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/client')>();
  return {
    ...actual,
    fetchOpencodePendingPermissions: vi.fn().mockResolvedValue([]),
    fetchOpencodePendingQuestions: vi.fn().mockResolvedValue([]),
    fetchOpencodeSessionStatuses: vi.fn().mockResolvedValue({}),
    fetchOpencodeActivity: vi.fn().mockResolvedValue(null),
    probeOpencodeHealth: vi.fn(),
    openOpencodeEventStream: vi.fn(),
  };
});

import {
  fetchOpencodeActivity,
  fetchOpencodeSessionStatuses,
  openOpencodeEventStream,
  probeOpencodeHealth,
  type OpencodeFrame,
} from '@/lib/hooks/sources/opencode/client';
import {
  closeOpencodeSubscription,
  getOpencodeLiveness,
  getOpencodeProbedActivity,
  isOpencodeSubscribed,
  OPENCODE_HEARTBEAT_TIMEOUT_MS,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import { attachOpencodeEventStream } from '@/lib/hooks/sources/opencode/runtime';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import {
  AGENT_SOURCE_STALE_AFTER_MS,
  declaredAgentSourceKind,
  describeAgentEventSource,
} from '@/lib/hooks/sources/define-source';
import { getAgentEventSource, listAgentEventSources } from '@/lib/hooks/sources/registry';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import type { SourceLiveness } from '@/lib/hooks/sources/types';

const TARGET = { worktreeId: 'wt-2054', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4818;
const VERSION = '1.18.22';

const LIVE = JSON.parse(
  readFileSync('tests/fixtures/opencode-liveness-2054/live-probe.json', 'utf-8')
) as {
  opencodeVersion: string;
  heartbeatIntervalsMs: { run1: number[]; run2: number[] };
  publishedStates: Record<string, Record<string, string>>;
};

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

let queued: Array<() => AsyncGenerator<OpencodeFrame>>;
let sandbox: string;
let portFile: string;

beforeAll(() => {
  sandbox = makeTempDir('opencode-2054-');
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
  queued = [];
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  if (existsSync(portFile)) writeFileSync(portFile, '{}\n');
  rememberOpencodePort(TARGET, PORT, '/tmp/wt-2054');
  vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({});
  vi.mocked(fetchOpencodeActivity).mockResolvedValue(null);
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: VERSION },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => {
      const next = queued.shift() ?? silentStream(signal);
      return next();
    }
  );
});

// =============================================================================
// The budget
// =============================================================================

describe('[#2054] the stale budget', () => {
  it('is the transport’s own heartbeat timeout, not a second number', () => {
    // The two constants live in modules that cannot import each other, so the
    // only thing keeping them equal is this assertion. A display threshold
    // shorter than the transport’s would call a stream stale while the
    // transport still called it live; a longer one would keep claiming `live`
    // after the watchdog had already torn the connection down.
    expect(AGENT_SOURCE_STALE_AFTER_MS).toBe(OPENCODE_HEARTBEAT_TIMEOUT_MS);
    expect(AGENT_SOURCE_STALE_AFTER_MS).toBe(30_000);
  });

  it('is three missed beats of the cadence that was measured', () => {
    // Live, 2026-08-26, opencode 1.18.22: five inter-beat gaps, all within 7ms
    // of 10s. The budget is not a guess about how often opencode speaks.
    const beats = [...LIVE.heartbeatIntervalsMs.run1, ...LIVE.heartbeatIntervalsMs.run2];
    expect(beats.length).toBeGreaterThanOrEqual(4);
    for (const beat of beats) expect(Math.abs(beat - 10_000)).toBeLessThan(100);
    expect(AGENT_SOURCE_STALE_AFTER_MS).toBe(3 * 10_000);
  });
});

// =============================================================================
// The fold, for every registered source
// =============================================================================

describe('[#2054] describeAgentEventSource', () => {
  const UNKNOWN: SourceLiveness = { state: 'unknown' };

  it('gives every push source a kind and nothing else', () => {
    // Acceptance criterion 2, at the layer that decides it. claude and codex
    // answer `{ state: 'unknown' }` by construction, and publishing `stale` for
    // an unmeasurable would put a warning on every pane in the app.
    for (const cliToolId of CLI_TOOL_IDS) {
      const source = getAgentEventSource(cliToolId);
      if (source.transport === 'pull') continue;
      const status = describeAgentEventSource(source, source.liveness(
        { worktreeId: 'wt', cliToolId, instanceId: cliToolId }
      ), Date.now());
      expect(Object.keys(status)).toEqual(['kind']);
      expect(status.liveness).toBeUndefined();
      expect(status.degradedReason).toBeUndefined();
    }
  });

  it('calls a tool with no source of its own a scraper, and one with hooks hooks', () => {
    // `vibe-local` is the row with no implementation: the registry hands back the
    // compatibility relay, whose `supportedEvents` is empty on purpose. That
    // emptiness is the evidence — nothing structured reads that tool.
    expect(declaredAgentSourceKind(getAgentEventSource('vibe-local'))).toBe('scraper');
    expect(declaredAgentSourceKind(getAgentEventSource('claude'))).toBe('hooks');
    expect(declaredAgentSourceKind(getAgentEventSource('codex'))).toBe('hooks');
    expect(declaredAgentSourceKind(getAgentEventSource('opencode'))).toBe('sse');
  });

  it('never invents a liveness for a tool the registry has not been given', () => {
    // Every registered source must be describable without naming a tool here.
    for (const source of listAgentEventSources()) {
      const status = describeAgentEventSource(source, UNKNOWN, Date.now());
      expect(['sse', 'hooks', 'scraper']).toContain(status.kind);
    }
  });

  it('publishes the four states the live probe recorded', () => {
    const now = 1_800_000_000_000;
    const opencode = getAgentEventSource('opencode');

    expect(
      describeAgentEventSource(opencode, { state: 'live', lastHeartbeatAt: now - 1_000 }, now)
    ).toEqual(LIVE.publishedStates.live);

    expect(
      describeAgentEventSource(
        opencode,
        { state: 'lost', since: now - 500, reason: 'port_identity_changed' },
        now
      )
    ).toEqual(LIVE.publishedStates.portIdentityChanged);

    expect(describeAgentEventSource(opencode, UNKNOWN, now)).toEqual(
      LIVE.publishedStates.neverSubscribed
    );
    expect(describeAgentEventSource(opencode, UNKNOWN, now)).toEqual(
      LIVE.publishedStates.afterClose
    );
  });

  it('turns a heartbeat older than the budget into stale without waiting for the watchdog', () => {
    const now = 1_800_000_000_000;
    const opencode = getAgentEventSource('opencode');
    const justInside = describeAgentEventSource(
      opencode,
      { state: 'live', lastHeartbeatAt: now - (AGENT_SOURCE_STALE_AFTER_MS - 1) },
      now
    );
    const justOutside = describeAgentEventSource(
      opencode,
      { state: 'live', lastHeartbeatAt: now - AGENT_SOURCE_STALE_AFTER_MS },
      now
    );
    expect(justInside).toEqual({ kind: 'sse', liveness: 'live' });
    // Still `sse`: the stream is held and the reconnect has not run. What the
    // operator needs to know is that it went quiet, not that it is gone.
    expect(justOutside).toEqual({
      kind: 'sse',
      liveness: 'stale',
      degradedReason: 'heartbeat_stale',
    });
  });

  it('forwards the transport’s own reason rather than a display token', () => {
    // A reason this build has never heard of must still reach the surface;
    // mapping it to "disconnected" here would hide every future one.
    expect(
      describeAgentEventSource(
        getAgentEventSource('opencode'),
        { state: 'lost', since: 1, reason: 'health-unreachable' },
        2
      )
    ).toEqual({ kind: 'scraper', liveness: 'stale', degradedReason: 'health-unreachable' });
  });
});

// =============================================================================
// The tombstone — the state that used to be deleted before anyone could read it
// =============================================================================

describe('[#2054] a port that changed hands', () => {
  it('keeps saying port_identity_changed after the subscription is dropped', async () => {
    // Reproduces the live measurement: `degradeToScraper` sets the reason and
    // then removes the entry from the map in the next statement, so before this
    // Issue every later read answered `unknown` — the same word an instance that
    // was never subscribed answers.
    vi.mocked(probeOpencodeHealth)
      .mockResolvedValueOnce({ kind: 'healthy', health: { healthy: true, version: VERSION } })
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: '9.9.9-squatter' } });
    queued.push(streamOf());

    await opencodeAgentEventSource.subscribe(TARGET, () => {});
    await vi.waitFor(() => expect(isOpencodeSubscribed(TARGET)).toBe(false), { timeout: 4000 });

    const liveness = getOpencodeLiveness(TARGET);
    expect(liveness.state).toBe('lost');
    expect(liveness.state === 'lost' && liveness.reason).toBe('port_identity_changed');
    expect(
      describeAgentEventSource(opencodeAgentEventSource, liveness, Date.now())
    ).toEqual(LIVE.publishedStates.portIdentityChanged);
  });

  it('stops saying it once the pane is closed', async () => {
    // Measured, and the reason the clear sits above `closeOpencodeSubscription`’s
    // early return: the one instance that has a tombstone is the one already
    // removed from the map, so a close that bailed on "no state" would leave the
    // reason describing a pane that has since been killed.
    vi.mocked(probeOpencodeHealth)
      .mockResolvedValueOnce({ kind: 'healthy', health: { healthy: true, version: VERSION } })
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: '9.9.9-squatter' } });
    queued.push(streamOf());

    await opencodeAgentEventSource.subscribe(TARGET, () => {});
    await vi.waitFor(() => expect(getOpencodeLiveness(TARGET).state).toBe('lost'), { timeout: 4000 });

    await closeOpencodeSubscription(TARGET);

    expect(getOpencodeLiveness(TARGET)).toEqual({ state: 'unknown' });
    expect(
      describeAgentEventSource(opencodeAgentEventSource, getOpencodeLiveness(TARGET), Date.now())
    ).toEqual(LIVE.publishedStates.afterClose);
  });

  it('answers unknown for an instance nothing ever subscribed to', () => {
    expect(getOpencodeLiveness({ ...TARGET, instanceId: 'opencode-never' })).toEqual({
      state: 'unknown',
    });
  });
});

// =============================================================================
// probeActivity — the method Phase 4-1 shipped with no caller
// =============================================================================

describe('[#2054] the post-attach activity probe', () => {
  it('asks the source once the stream is attached, and records the answer', async () => {
    // The gap it fills: a stream that opens mid-turn delivers its first frame
    // when that turn ENDS, so between the attach and the next `session.idle`
    // nothing but the screen could answer "is this pane working right now?".
    vi.mocked(fetchOpencodeActivity).mockResolvedValue('busy');

    const attached = await attachOpencodeEventStream(TARGET);

    expect(attached).toBe(true);
    expect(vi.mocked(fetchOpencodeActivity)).toHaveBeenCalledWith(PORT);
    expect(getOpencodeProbedActivity(TARGET)?.activity).toBe('busy');
    expect(getOpencodeProbedActivity(TARGET)?.at).toBeGreaterThan(0);
  });

  it('records a null rather than nothing when the source could not be asked', async () => {
    // `probeActivity` answers null for a push source and for an instance with no
    // port. A recorded null and an absent record are different facts: one says
    // the probe ran and got no answer, the other that the stream never attached.
    vi.mocked(fetchOpencodeActivity).mockResolvedValue(null);

    await attachOpencodeEventStream(TARGET);

    expect(getOpencodeProbedActivity(TARGET)).not.toBeNull();
    expect(getOpencodeProbedActivity(TARGET)?.activity).toBeNull();
  });

  it('does not fail the attach when the probe throws', async () => {
    vi.mocked(fetchOpencodeActivity).mockRejectedValue(new Error('socket hang up'));

    await expect(attachOpencodeEventStream(TARGET)).resolves.toBe(true);
    expect(getOpencodeProbedActivity(TARGET)?.activity).toBeNull();
  });

  it('forgets the answer when the pane is closed', async () => {
    vi.mocked(fetchOpencodeActivity).mockResolvedValue('idle');
    await attachOpencodeEventStream(TARGET);
    expect(getOpencodeProbedActivity(TARGET)?.activity).toBe('idle');

    await closeOpencodeSubscription(TARGET);

    expect(getOpencodeProbedActivity(TARGET)).toBeNull();
  });

  it('answers null for a tool whose source cannot be asked at all', async () => {
    // C7: an event cannot be re-read. Every push source returns null, which is
    // what keeps the probe from becoming a per-tool branch at the call site.
    for (const cliToolId of CLI_TOOL_IDS) {
      const source = getAgentEventSource(cliToolId);
      if (source.transport === 'pull') continue;
      await expect(
        source.probeActivity({ worktreeId: 'wt', cliToolId, instanceId: cliToolId })
      ).resolves.toBeNull();
    }
  });
});

// =============================================================================
// The measurement itself
// =============================================================================

describe('[#2054] the fixture', () => {
  it('was taken on the version this Issue targets', () => {
    expect(LIVE.opencodeVersion).toBe('1.18.22');
  });
});
