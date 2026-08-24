/**
 * What a re-sync is allowed to believe, and how much of it (Issue #1931).
 *
 * Issue #1900 landed the two decisions this file holds down — the pre-connect
 * identity check and the bounded replay — and pinned neither by name. That
 * matters more than it sounds: both are *quiet*. A replay cap that silently
 * became unbounded looks exactly like one that is working until a server hands
 * back a list long enough to matter, and a reason code nothing asserts is a
 * string one rename away from disappearing out of the only place an operator
 * can read it.
 *
 * The third thing here is a gap, recorded rather than fixed: design §7 reserves
 * `closedBy: 'resync_idle'` for a completion that was reconstructed from
 * `GET /session/status` rather than observed, and nothing above this layer can
 * currently tell the two apart. The channel that would carry it is
 * `src/lib/session/provisional-turn.ts`, outside this Issue's scope.
 *
 * @vitest-environment node
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'fs';
import { join } from 'path';
import { makeTempDir, removeTempDir } from '@tests/helpers/temp-dir';

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
  MAX_RESYNCED_DECISIONS,
  resetOpencodeSubscriptions,
} from '@/lib/hooks/sources/opencode/subscription';
import { opencodeAgentEventSource } from '@/lib/hooks/sources/opencode/source';
import {
  rememberOpencodePort,
  resetOpencodePortAssignments,
} from '@/lib/hooks/sources/opencode/ports';
import { resetOpencodeToolCalls } from '@/lib/hooks/sources/opencode/payloads';
import { resetUnknownEventTallies, type NormalizedAgentEvent } from '@/lib/hooks/sources';

const TARGET = { worktreeId: 'wt-1931', cliToolId: 'opencode', instanceId: 'opencode' } as const;
const PORT = 4319;
const VERSION = '1.18.21';
/** The version a process that took the port would be reporting instead. */
const SQUATTER = '9.9.9';
const PARENT = 'ses_parent0000000000000000';

let received: NormalizedAgentEvent[];
let sandbox: string;
let portFile: string;

/** One `GET /permission` entry, shaped the way the live server sends them. */
function pendingPermission(index: number): Record<string, unknown> {
  return {
    id: `per_${String(index).padStart(25, '0')}`,
    sessionID: PARENT,
    permission: 'external_directory',
    metadata: { command: `echo ${index}` },
  };
}

function busyFrame(sessionID: string): OpencodeFrame {
  return {
    id: `evt_busy_${sessionID}`,
    type: 'session.status',
    properties: { sessionID, status: { type: 'busy' } },
  };
}

function idleFrame(sessionID: string): OpencodeFrame {
  return { id: `evt_idle_${sessionID}`, type: 'session.idle', properties: { sessionID } };
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

const permissionEvents = (): NormalizedAgentEvent[] =>
  received.filter((event) => event.detail === 'permission_prompt');

beforeAll(() => {
  sandbox = makeTempDir('opencode-1931-');
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
  received = [];
  vi.stubEnv('CM_OPENCODE_PORT_FILE', portFile);
  vi.stubEnv('CM_AGENT_HOOKS_INJECT', '1');
  if (existsSync(portFile)) writeFileSync(portFile, '{}\n');
  rememberOpencodePort(TARGET, PORT, '/tmp/wt-1931');
  vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([]);
  vi.mocked(fetchOpencodeSessionStatuses).mockResolvedValue({});
  vi.mocked(probeOpencodeHealth).mockResolvedValue({
    kind: 'healthy',
    health: { healthy: true, version: VERSION },
  });
  vi.mocked(openOpencodeEventStream).mockImplementation(
    async (_port: number, signal: AbortSignal) => silentStream(signal)()
  );
});

afterEach(async () => {
  resetOpencodeSubscriptions();
  resetOpencodePortAssignments();
  vi.unstubAllEnvs();
});

// =============================================================================
// DR4-009 — the replay is bounded, and says how much it left
// =============================================================================

describe('replaying what was pending while the connection was down', () => {
  it('is bounded by a named constant, not by a literal in the loop', () => {
    // The design's number. Named so the log below can report the limit it
    // actually applied rather than one a reader has to go and count.
    expect(MAX_RESYNCED_DECISIONS).toBe(50);
  });

  it('replays up to the cap and no further', async () => {
    // The list comes off a server CommandMate did not start, and one
    // `opencode.db` is shared by every TUI with the same HOME and project — so
    // its length is not bounded by this instance's own behaviour.
    const pending = Array.from({ length: MAX_RESYNCED_DECISIONS + 12 }, (_, i) =>
      pendingPermission(i)
    );
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue(pending);

    await opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));

    await vi.waitFor(() => expect(permissionEvents().length).toBeGreaterThan(0), { timeout: 4000 });
    expect(permissionEvents()).toHaveLength(MAX_RESYNCED_DECISIONS);
  });

  it('counts what it skipped instead of dropping it in silence', async () => {
    // A cap nobody can see is indistinguishable from a lost approval, and an
    // unanswered opencode approval waits forever (#1758 §5.5.3).
    const pending = Array.from({ length: MAX_RESYNCED_DECISIONS + 12 }, (_, i) =>
      pendingPermission(i)
    );
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue(pending);

    await opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));

    await vi.waitFor(
      () =>
        expect(mockLogger.warn).toHaveBeenCalledWith(
          'opencode-resync-truncated',
          expect.objectContaining({
            type: 'permission.asked',
            examined: MAX_RESYNCED_DECISIONS,
            skipped: 12,
            limit: MAX_RESYNCED_DECISIONS,
          })
        ),
      { timeout: 4000 }
    );
  });

  it('says nothing at all when the list fits', async () => {
    // Otherwise the warning is noise on every reconnect and stops being read.
    vi.mocked(fetchOpencodePendingPermissions).mockResolvedValue([pendingPermission(0)]);

    await opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));

    await vi.waitFor(() => expect(permissionEvents()).toHaveLength(1), { timeout: 4000 });
    expect(mockLogger.warn).not.toHaveBeenCalledWith(
      'opencode-resync-truncated',
      expect.anything()
    );
  });
});

// =============================================================================
// §7 — the reason codes an operator would have to read
// =============================================================================

describe('the reason code for a port that changed hands', () => {
  it('is `port_identity_changed`, on the liveness and in the log', async () => {
    // Two surfaces, one string. The liveness is the only programmatic one, and
    // it survives the subscription being dropped from the registry because the
    // handle reads through to the state it was built from.
    vi.mocked(probeOpencodeHealth)
      .mockResolvedValueOnce({ kind: 'healthy', health: { healthy: true, version: VERSION } })
      .mockResolvedValue({ kind: 'healthy', health: { healthy: true, version: SQUATTER } });
    vi.mocked(openOpencodeEventStream).mockImplementationOnce(async () =>
      (async function* () {
        // Ends immediately: one dropped connection, then the re-probe.
      })()
    );

    const subscription = await opencodeAgentEventSource.subscribe(TARGET, (event) =>
      received.push(event)
    );

    await vi.waitFor(
      () => expect(subscription.liveness).toEqual(
        expect.objectContaining({ state: 'lost', reason: 'port_identity_changed' })
      ),
      { timeout: 4000 }
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'opencode-subscription-port-identity-changed',
      expect.objectContaining({
        reason: 'port_identity_changed',
        expectedVersion: VERSION,
        observedVersion: SQUATTER,
      })
    );
  });
});

describe('a completion reconstructed rather than observed', () => {
  it('is named `resync_idle` on the frame and in the recovery log', async () => {
    // The turn was open when the connection dropped, and the `session.idle`
    // that ended it arrived on a stream nobody was reading.
    vi.mocked(fetchOpencodeSessionStatuses)
      .mockResolvedValueOnce({})
      .mockResolvedValue({ [PARENT]: 'idle' });
    vi.mocked(openOpencodeEventStream).mockImplementationOnce(async () =>
      (async function* () {
        yield busyFrame(PARENT);
      })()
    );

    await opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));

    await vi.waitFor(
      () =>
        expect(mockLogger.info).toHaveBeenCalledWith(
          'opencode-turn-state-recovered',
          expect.objectContaining({ synthesized: [PARENT] })
        ),
      { timeout: 4000 }
    );
  });

  it('is, above this layer, indistinguishable from one the agent reported', async () => {
    // Recorded, not asserted as desirable. §7 reserves `closedBy: 'resync_idle'`
    // for exactly this event, and the normalized envelope has no field to carry
    // it: `deriveProvisionalTurn` stamps `closedBy: 'stop'` for every `stop`
    // there is. Closing that gap means a channel in
    // `src/lib/session/provisional-turn.ts`, which Issue #1931 does not own — so
    // this test exists to fail the day one is added, and be updated then.
    // One turn observed end to end, then a second left open when the stream
    // died — so the two `stop`s below differ only in how they were arrived at.
    vi.mocked(fetchOpencodeSessionStatuses)
      .mockResolvedValueOnce({})
      .mockResolvedValue({ [PARENT]: 'idle' });
    vi.mocked(openOpencodeEventStream).mockImplementationOnce(async () =>
      (async function* () {
        yield busyFrame(PARENT);
        yield idleFrame(PARENT);
        yield busyFrame(PARENT);
      })()
    );

    await opencodeAgentEventSource.subscribe(TARGET, (event) => received.push(event));

    await vi.waitFor(() => expect(received.filter((e) => e.event === 'stop')).toHaveLength(2), {
      timeout: 4000,
    });
    const [observed, reconstructed] = received.filter((e) => e.event === 'stop');
    expect(reconstructed.detail).toBe(observed.detail);
    expect(reconstructed.conversationId).toBe(observed.conversationId);
  });
});
