/**
 * Unit tests for the server-side realtime broadcasters (Issue #1120).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  hasRoomSubscribers: vi.fn(() => true),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: (cliToolId: string) => ({
        getSessionName: (worktreeId: string, instanceId?: string) =>
          `mcbd-${cliToolId}-${worktreeId}-${instanceId ?? cliToolId}`,
      }),
    }),
  },
}));
vi.mock('@/lib/tmux/tmux-capture-cache', () => ({ invalidateCache: vi.fn() }));
vi.mock('@/lib/session/current-output-builder', () => ({
  buildCurrentOutput: vi.fn(async () => ({
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'running',
    sessionStatusReason: 'thinking_indicator',
    content: '',
    fullOutput: 'terminal out',
    thinking: true,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    lineCount: 1,
  })),
}));

import { broadcast, hasRoomSubscribers } from '@/lib/ws-server';
import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';
import {
  broadcastTerminalSnapshot,
  broadcastTerminalSnapshotAfterInteraction,
  broadcastSessionStatus,
  __resetTerminalBroadcastState,
} from '@/lib/realtime/terminal-broadcast';
import { getAgentEventSource } from '@/lib/hooks/sources/registry';

const mockBroadcast = vi.mocked(broadcast);
const mockHasSubscribers = vi.mocked(hasRoomSubscribers);

/** No hook has reported anything — the shape every payload carries (Issue #1722). */
const NO_STRUCTURED_EVENTS = {
  lastEventType: null,
  lastEventAt: null,
  lastEventDetail: null,
  // Issue #1926: the turn fields are derived from that same absent event, so
  // "nothing has reported anything" is four more nulls rather than a shape.
  turnId: null,
  openedAt: null,
  closedAt: null,
  closedBy: null,
  // Issue #1725: no dialog reported either.
  promptWaitingSince: null,
  promptWaitingSource: null,
  // Issue #1902: nothing on this session had a `tool_input` that needed
  // rewriting — the ordinary case for every tool but copilot.
  toolInputNormalization: null,
  // Issue #1898: additive on `StructuredEventsPayload`, null on every session
  // nothing has been adjudicated for.
  permissionDecision: null,
  // Issue #1924: the source block is present on every payload, reported or not —
  // it describes the source, not the session. Read from the registry rather than
  // transcribed, so this fixture cannot claim a capability set no source has.
  source: {
    cliToolId: 'claude',
    capabilities: getAgentEventSource('claude').capabilities,
    // Issue #2054: the same shape the builder publishes for a push source —
    // `hooks`, and neither of the two fields only a subscription can fill in.
    kind: 'hooks',
    probedActivity: null,
  },
} as const;

/** Nothing has reported a model or an effort either (Issue #1785). */
const NO_MODEL_INFO = { model: null, reasoningEffort: null } as const;

/** The dedup guard has suppressed no prompt for this session (Issue #1695). */
const NO_PROMPT_DEDUP = { promptDedup: { skippedCount: 0, lastSkippedAt: null } } as const;

/** No upstream API failure signature on the frame (Issue #1839). */
const NO_UPSTREAM_FAULT = { upstreamFault: null } as const;

/** No second column sharing rows with the transcript (Issue #2095). */
const NO_PANE_OBSTRUCTION = { paneObstruction: null } as const;

/** Nothing unsent in the composer (Issue #1879). */
const NO_COMPOSER_TEXT = { composerText: null, composerState: 'empty' } as const;

/**
 * The evidence trio Issue #1926 adds to every payload.
 *
 * `positive` because the fixture's verdict is `thinking_indicator` — a frame the
 * detector positively recognised — and the latch has nothing older to report on
 * a session this fixture invented one line ago.
 */
const POSITIVE_EVIDENCE = {
  statusEvidence: 'positive',
  lastKnownStatus: null,
  lastKnownStatusAt: null,
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  __resetTerminalBroadcastState();
  mockHasSubscribers.mockReturnValue(true);
  vi.mocked(buildCurrentOutput).mockResolvedValue({
    isRunning: true,
    cliToolId: 'claude',
    sessionStatus: 'running',
    sessionStatusReason: 'thinking_indicator',
    content: '',
    fullOutput: 'terminal out',
    thinking: true,
    isPromptWaiting: false,
    promptData: null,
    isSelectionListActive: false,
    isPagerActive: false,
    isUnclassifiedActive: false,
    lineCount: 1,
    lastStopEventAt: null,
    structuredEvents: NO_STRUCTURED_EVENTS,
    ...NO_MODEL_INFO,
    ...NO_PROMPT_DEDUP,
    ...NO_UPSTREAM_FAULT,
    ...NO_PANE_OBSTRUCTION,
    ...NO_COMPOSER_TEXT,
    ...POSITIVE_EVIDENCE,
  });
});

afterEach(() => vi.useRealTimers());

describe('broadcastTerminalSnapshot', () => {
  it('no-ops (no capture) when the room has no subscribers', async () => {
    mockHasSubscribers.mockReturnValue(false);
    await broadcastTerminalSnapshot('wt-1', 'claude');
    expect(mockBroadcast).not.toHaveBeenCalled();
  });

  it('broadcasts a monotonically-versioned terminal_snapshot', async () => {
    await broadcastTerminalSnapshot('wt-1', 'claude');
    await broadcastTerminalSnapshot('wt-1', 'claude');

    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast.mock.calls[0][0]).toBe('wt-1');
    expect(mockBroadcast.mock.calls[0][1]).toMatchObject({
      type: 'terminal_snapshot',
      worktreeId: 'wt-1',
      cliToolId: 'claude',
      instanceId: 'claude',
      output: 'terminal out',
      isRunning: true,
      thinking: true,
      version: 1,
    });
    expect(mockBroadcast.mock.calls[1][1]).toMatchObject({ version: 2 });
  });

  it('tracks versions independently per instance', async () => {
    await broadcastTerminalSnapshot('wt-1', 'claude');
    await broadcastTerminalSnapshot('wt-1', 'claude', 'claude-2');
    expect(mockBroadcast.mock.calls[0][1]).toMatchObject({ instanceId: 'claude', version: 1 });
    expect(mockBroadcast.mock.calls[1][1]).toMatchObject({ instanceId: 'claude-2', version: 1 });
  });
});

describe('broadcastTerminalSnapshotAfterInteraction', () => {
  it('pushes immediately, invalidates the target instance cache, and pushes one changed redraw', async () => {
    vi.useFakeTimers();
    vi.mocked(buildCurrentOutput)
      .mockResolvedValueOnce({
        isRunning: true,
        cliToolId: 'claude',
        sessionStatus: 'waiting',
        sessionStatusReason: 'prompt_detected',
        content: '',
        fullOutput: 'old frame',
        lineCount: 1,
        lastStopEventAt: null,
        structuredEvents: NO_STRUCTURED_EVENTS,
        ...NO_MODEL_INFO,
        ...NO_PROMPT_DEDUP,
        ...NO_UPSTREAM_FAULT,
        ...NO_PANE_OBSTRUCTION,
        ...NO_COMPOSER_TEXT,
    ...POSITIVE_EVIDENCE,
      })
      .mockResolvedValueOnce({
        isRunning: true,
        cliToolId: 'claude',
        sessionStatus: 'running',
        sessionStatusReason: 'thinking_indicator',
        content: '',
        fullOutput: 'redrawn frame',
        thinking: true,
        lineCount: 1,
        lastStopEventAt: null,
        structuredEvents: NO_STRUCTURED_EVENTS,
        ...NO_MODEL_INFO,
        ...NO_PROMPT_DEDUP,
        ...NO_UPSTREAM_FAULT,
        ...NO_PANE_OBSTRUCTION,
        ...NO_COMPOSER_TEXT,
    ...POSITIVE_EVIDENCE,
      });

    const pending = broadcastTerminalSnapshotAfterInteraction(
      'wt-1',
      'claude',
      'claude-2',
      [10],
    );
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(invalidateCache).toHaveBeenCalledTimes(2);
    expect(invalidateCache).toHaveBeenCalledWith('mcbd-claude-wt-1-claude-2');
    expect(mockBroadcast).toHaveBeenCalledTimes(2);
    expect(mockBroadcast.mock.calls[0][1]).toMatchObject({
      instanceId: 'claude-2',
      output: 'old frame',
      version: 1,
    });
    expect(mockBroadcast.mock.calls[1][1]).toMatchObject({
      instanceId: 'claude-2',
      output: 'redrawn frame',
      version: 2,
    });
  });

  it('does not duplicate the initial snapshot when retry frames are unchanged', async () => {
    vi.useFakeTimers();
    const pending = broadcastTerminalSnapshotAfterInteraction('wt-1', 'claude', undefined, [5, 5]);
    await vi.advanceTimersByTimeAsync(10);
    await pending;

    expect(mockBroadcast).toHaveBeenCalledTimes(1);
  });
});

describe('broadcastSessionStatus', () => {
  it('broadcasts a running transition', () => {
    broadcastSessionStatus('wt-1', true, { cliTool: 'claude', instance: null });
    expect(mockBroadcast).toHaveBeenCalledWith(
      'wt-1',
      expect.objectContaining({
        type: 'session_status_changed',
        worktreeId: 'wt-1',
        isRunning: true,
        cliTool: 'claude',
        instance: null,
      }),
    );
  });
});
