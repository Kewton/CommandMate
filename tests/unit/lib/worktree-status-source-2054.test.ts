/**
 * `CliToolSessionStatus.eventSource` — the half of a pane's state the frame
 * cannot show (Issue #2054).
 *
 * Every other field on this object is something the SCREEN said. This one says
 * whether anything other than the screen is reading the pane at all, which is
 * the difference between "opencode looks idle" and "opencode looks idle and its
 * event stream has been gone for a minute". Before this Issue the two were
 * indistinguishable here — `liveness` and `degraded` appeared nowhere in the
 * module.
 *
 * The suite is written against the two ways adding it goes wrong: a key that
 * appears on every tool (which would break the `toEqual` suites next door and
 * put a warning on panes nobody measured), and a key that appears for a session
 * that is not running (true, and useless — the subscription is closed when the
 * pane is killed, so every stopped opencode row would claim a degradation).
 *
 * @vitest-environment node
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { CLIToolType, AgentInstance } from '@/lib/cli-tools/types';

vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          instanceId && instanceId !== cliToolId
            ? `${cliToolId}-${worktreeId}-${instanceId}`
            : `${cliToolId}-${worktreeId}`,
        name: cliToolId,
      }),
    }),
  },
}));

vi.mock('@/lib/cli-tools/types', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/lib/cli-tools/types')>();
  return {
    ...original,
    CLI_TOOL_IDS: ['claude', 'opencode'] as readonly CLIToolType[],
  };
});

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn().mockResolvedValue('$ '),
}));

vi.mock('@/lib/session/claude-session', () => ({
  isSessionHealthy: vi.fn().mockResolvedValue({ healthy: true }),
}));

vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getLastServerResponseTimestamp: vi.fn().mockReturnValue(null),
  buildCompositeKey: vi.fn(
    (worktreeId: string, cliToolId: string, instanceId?: string) =>
      `${worktreeId}:${cliToolId}:${instanceId ?? cliToolId}`,
  ),
}));

vi.mock('@/lib/hooks/sources/opencode/subscription', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@/lib/hooks/sources/opencode/subscription')>();
  return { ...actual, getOpencodeLiveness: vi.fn(() => ({ state: 'unknown' })) };
});

import { detectWorktreeSessionStatus } from '@/lib/session/worktree-status-helper';
import { getOpencodeLiveness } from '@/lib/hooks/sources/opencode/subscription';
import { clearLastKnownStatuses } from '@/lib/session/status-evidence';

const mockDb = {} as ReturnType<typeof import('@/lib/db/db-instance').getDbInstance>;
const mockGetMessages = vi.fn().mockReturnValue([]);
const mockMarkPending = vi.fn();
const mockGetAgentInstances = vi.fn(() => [] as AgentInstance[]);

const RUNNING = ['claude-wt-1', 'opencode-wt-1'];

async function detect(sessions: string[] = RUNNING) {
  return detectWorktreeSessionStatus(
    'wt-1',
    new Set(sessions),
    mockDb,
    mockGetMessages,
    mockMarkPending,
    mockGetAgentInstances,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  clearLastKnownStatuses();
  mockGetMessages.mockReturnValue([]);
  mockGetAgentInstances.mockReturnValue([]);
  vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'unknown' });
});

describe('[#2054] eventSource is published for the source that can be degraded', () => {
  it('leaves a hook tool’s status object exactly as it was', async () => {
    // Acceptance criterion 2 at this layer. `claude` answers "unknown" by
    // construction, so there is nothing to publish and the key must not appear:
    // the neighbouring suites compare these objects with `toEqual`.
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'live',
      lastHeartbeatAt: Date.now(),
    });

    const result = await detect();

    expect(result.sessionStatusByInstance.claude).toBeDefined();
    expect('eventSource' in (result.sessionStatusByInstance.claude ?? {})).toBe(false);
  });

  it('reports a live opencode stream', async () => {
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'live',
      lastHeartbeatAt: Date.now(),
    });

    const result = await detect();

    expect(result.sessionStatusByInstance.opencode?.eventSource).toEqual({
      kind: 'sse',
      liveness: 'live',
    });
  });

  it('reports a stolen port as a scraper fallback, naming the transport’s reason', async () => {
    // The measured state — see `docs/design/opencode-server-live-verification.md`
    // §25 and `tests/fixtures/opencode-liveness-2054/live-probe.json`.
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'lost',
      since: Date.now(),
      reason: 'port_identity_changed',
    });

    const result = await detect();

    expect(result.sessionStatusByInstance.opencode?.eventSource).toEqual({
      kind: 'scraper',
      liveness: 'stale',
      degradedReason: 'port_identity_changed',
    });
  });

  it('calls a heartbeat older than 30s stale', async () => {
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'live',
      lastHeartbeatAt: Date.now() - 31_000,
    });

    const result = await detect();

    expect(result.sessionStatusByInstance.opencode?.eventSource).toEqual({
      kind: 'sse',
      liveness: 'stale',
      degradedReason: 'heartbeat_stale',
    });
  });

  it('says a running pane with no subscription is on the scraper', async () => {
    const result = await detect();

    expect(result.sessionStatusByInstance.opencode?.eventSource).toEqual({
      kind: 'scraper',
      degradedReason: 'not_subscribed',
    });
  });

  it('publishes nothing at all for a session that is not running', async () => {
    // The subscription is closed when the pane is killed, so "no stream" is the
    // answer for every stopped opencode instance in the app: true, and useless.
    vi.mocked(getOpencodeLiveness).mockReturnValue({ state: 'unknown' });

    const result = await detect([]);

    expect(result.sessionStatusByInstance.opencode?.isRunning).toBe(false);
    expect('eventSource' in (result.sessionStatusByInstance.opencode ?? {})).toBe(false);
  });

  it('asks about each instance, not about the tool', async () => {
    // Two panes of one tool can be on different sides of a disconnection.
    mockGetAgentInstances.mockReturnValue([
      { id: 'opencode-2', cliTool: 'opencode', alias: 'opencode 2', order: 1 },
    ] as AgentInstance[]);
    vi.mocked(getOpencodeLiveness).mockImplementation((target) =>
      target.instanceId === 'opencode-2'
        ? { state: 'lost', since: 1, reason: 'port_identity_changed' }
        : { state: 'live', lastHeartbeatAt: Date.now() },
    );

    const result = await detect([...RUNNING, 'opencode-wt-1-opencode-2']);

    expect(result.sessionStatusByInstance.opencode?.eventSource?.kind).toBe('sse');
    expect(result.sessionStatusByInstance['opencode-2']?.eventSource?.kind).toBe('scraper');
  });

  it('drops it from the per-CLI aggregate, which cannot name an instance', async () => {
    // The same rule `model` / `statusEvidence` follow: there is no logical-OR of
    // two connection states, and an aggregate that picked one would describe a
    // pane the user is not looking at.
    mockGetAgentInstances.mockReturnValue([
      { id: 'opencode-2', cliTool: 'opencode', alias: 'opencode 2', order: 1 },
    ] as AgentInstance[]);
    vi.mocked(getOpencodeLiveness).mockReturnValue({
      state: 'live',
      lastHeartbeatAt: Date.now(),
    });

    const result = await detect([...RUNNING, 'opencode-wt-1-opencode-2']);

    expect('eventSource' in (result.sessionStatusByCli.opencode ?? {})).toBe(false);
  });
});
