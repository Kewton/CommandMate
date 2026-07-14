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

const mockBroadcast = vi.mocked(broadcast);
const mockHasSubscribers = vi.mocked(hasRoomSubscribers);

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
