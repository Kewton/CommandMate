/**
 * Session cleanup global session tests
 * Issue #649: Test cleanupGlobalSessions function
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock logger
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock response-poller
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
  clearPromptHashCache: vi.fn(),
}));

// Mock auto-yes and schedule modules
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  stopAutoYesPollingByWorktree: vi.fn(),
  deleteAutoYesStateByWorktree: vi.fn(),
}));

vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
}));

vi.mock('@/lib/timer-manager', () => ({
  stopTimersForWorktree: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  clearAllCache: vi.fn(),
}));

// Mock global-session-poller
vi.mock('@/lib/polling/global-session-poller', () => ({
  stopAllGlobalSessionPolling: vi.fn(),
}));

// Mock CLIToolManager
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn().mockReturnValue({
      getTool: vi.fn().mockReturnValue({
        getSessionName: vi.fn().mockImplementation(
          (worktreeId: string) => `mcbd-claude-${worktreeId}`,
        ),
        isRunning: vi.fn().mockResolvedValue(false),
      }),
    }),
  },
}));

// Mock tmux
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  killSession: vi.fn(),
}));

// Mock syncWorktreesToDB
vi.mock('@/lib/git/worktrees', () => ({
  syncWorktreesToDB: vi.fn().mockReturnValue({
    added: [],
    updated: [],
    deletedIds: [],
    unchanged: 0,
  }),
}));

import { cleanupGlobalSessions } from '@/lib/session-cleanup';
import { CLI_TOOL_IDS } from '@/lib/cli-tools/types';
import { stopAllGlobalSessionPolling } from '@/lib/polling/global-session-poller';
import { hasSession, killSession } from '@/lib/tmux/tmux';
import { CLIToolManager } from '@/lib/cli-tools/manager';

const mockedStopAll = vi.mocked(stopAllGlobalSessionPolling);
const mockedHasSession = vi.mocked(hasSession);
const mockedKillSession = vi.mocked(killSession);

describe('cleanupGlobalSessions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should stop all global pollers', async () => {
    mockedHasSession.mockResolvedValue(false);

    await cleanupGlobalSessions();

    expect(mockedStopAll).toHaveBeenCalledTimes(1);
  });

  it('should kill sessions that exist', async () => {
    mockedHasSession.mockResolvedValue(true);
    mockedKillSession.mockResolvedValue(true);

    const killed = await cleanupGlobalSessions();

    // Should check and kill for each CLI tool
    expect(mockedHasSession).toHaveBeenCalledTimes(CLI_TOOL_IDS.length);
    expect(mockedKillSession).toHaveBeenCalledTimes(CLI_TOOL_IDS.length);
    expect(killed).toBe(CLI_TOOL_IDS.length);
  });

  it('should not kill sessions that do not exist', async () => {
    mockedHasSession.mockResolvedValue(false);

    const killed = await cleanupGlobalSessions();

    expect(mockedHasSession).toHaveBeenCalledTimes(CLI_TOOL_IDS.length);
    expect(mockedKillSession).not.toHaveBeenCalled();
    expect(killed).toBe(0);
  });

  it('should handle kill errors gracefully', async () => {
    mockedHasSession.mockResolvedValue(true);
    mockedKillSession.mockRejectedValue(new Error('kill failed'));

    // Should not throw
    const killed = await cleanupGlobalSessions();
    expect(killed).toBe(0);
  });

  it('should use __global__ as worktree ID for session names', async () => {
    mockedHasSession.mockResolvedValue(false);

    await cleanupGlobalSessions();

    // Check that getTool was called and getSessionName was called with '__global__'
    const manager = CLIToolManager.getInstance();
    const tool = manager.getTool('claude');
    const getSessionNameMock = vi.mocked(tool.getSessionName);
    for (const call of getSessionNameMock.mock.calls) {
      expect(call[0]).toBe('__global__');
    }
  });
});
