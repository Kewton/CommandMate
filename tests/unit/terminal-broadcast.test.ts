/**
 * Unit tests for the server-side realtime broadcasters (Issue #1120).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/lib/ws-server', () => ({
  broadcast: vi.fn(),
  hasRoomSubscribers: vi.fn(() => true),
}));
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: vi.fn(() => ({})) }));
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
import {
  broadcastTerminalSnapshot,
  broadcastSessionStatus,
  __resetTerminalBroadcastState,
} from '@/lib/realtime/terminal-broadcast';

const mockBroadcast = vi.mocked(broadcast);
const mockHasSubscribers = vi.mocked(hasRoomSubscribers);

beforeEach(() => {
  vi.clearAllMocks();
  __resetTerminalBroadcastState();
  mockHasSubscribers.mockReturnValue(true);
});

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
