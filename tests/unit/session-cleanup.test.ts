/**
 * Session cleanup utility unit tests
 * Issue #69: Repository delete feature
 * Issue #526: killWorktreeSession() and syncWorktreesAndCleanup() tests
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock response-poller before importing
vi.mock('@/lib/polling/response-poller', () => ({
  stopPolling: vi.fn(),
}));

// Mock auto-yes and schedule modules
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  stopAutoYesPolling: vi.fn(),
  deleteAutoYesState: vi.fn(),
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

// Mock CLIToolManager for killWorktreeSession tests
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn().mockReturnValue({
      getTool: vi.fn(),
    }),
  },
}));

// Mock tmux killSession
vi.mock('@/lib/tmux/tmux', () => ({
  killSession: vi.fn(),
}));

// Mock syncWorktreesToDB for syncWorktreesAndCleanup tests
vi.mock('@/lib/git/worktrees', () => ({
  syncWorktreesToDB: vi.fn(),
}));

// Import after mocking
import {
  cleanupWorktreeSessions,
  cleanupMultipleWorktrees,
  killWorktreeSession,
  syncWorktreesAndCleanup,
  type WorktreeCleanupResult,
} from '@/lib/session-cleanup';
import { stopPolling as stopResponsePolling } from '@/lib/polling/response-poller';
import { CLIToolManager } from '@/lib/cli-tools/manager';
import { killSession } from '@/lib/tmux/tmux';
import { syncWorktreesToDB } from '@/lib/git/worktrees';

describe('Session Cleanup Utility', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Re-apply default mock for CLIToolManager.getInstance after reset
    vi.mocked(CLIToolManager.getInstance).mockReturnValue({
      getTool: vi.fn(),
    } as any);
  });

  describe('cleanupWorktreeSessions', () => {
    it('should call killSession for all CLI tools', async () => {
      const killSessionFn = vi.fn().mockResolvedValue(true);

      const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

      // Should call killSession for claude, codex, gemini, vibe-local, opencode
      expect(killSessionFn).toHaveBeenCalledTimes(5);
      expect(killSessionFn).toHaveBeenCalledWith('wt-1', 'claude');
      expect(killSessionFn).toHaveBeenCalledWith('wt-1', 'codex');
      expect(killSessionFn).toHaveBeenCalledWith('wt-1', 'gemini');
      expect(killSessionFn).toHaveBeenCalledWith('wt-1', 'vibe-local');
      expect(killSessionFn).toHaveBeenCalledWith('wt-1', 'opencode');
    });

    it('should stop response-poller for all CLI tools', async () => {
      const killSessionFn = vi.fn().mockResolvedValue(true);

      await cleanupWorktreeSessions('wt-1', killSessionFn);

      // Should call stopPolling for each tool
      expect(stopResponsePolling).toHaveBeenCalledTimes(5);
      expect(stopResponsePolling).toHaveBeenCalledWith('wt-1', 'claude');
      expect(stopResponsePolling).toHaveBeenCalledWith('wt-1', 'codex');
      expect(stopResponsePolling).toHaveBeenCalledWith('wt-1', 'gemini');
      expect(stopResponsePolling).toHaveBeenCalledWith('wt-1', 'vibe-local');
      expect(stopResponsePolling).toHaveBeenCalledWith('wt-1', 'opencode');
    });


    it('should return killed sessions list', async () => {
      const killSessionFn = vi.fn()
        .mockResolvedValueOnce(true)  // claude
        .mockResolvedValueOnce(false) // codex (not running)
        .mockResolvedValueOnce(true); // gemini

      const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

      expect(result.worktreeId).toBe('wt-1');
      expect(result.sessionsKilled).toContain('claude');
      expect(result.sessionsKilled).not.toContain('codex');
      expect(result.sessionsKilled).toContain('gemini');
    });

    it('should collect session kill errors', async () => {
      const killSessionFn = vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('Kill failed'))
        .mockResolvedValueOnce(true);

      const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

      expect(result.sessionErrors).toHaveLength(1);
      expect(result.sessionErrors[0]).toContain('codex');
      expect(result.sessionErrors[0]).toContain('Kill failed');
    });

    it('should collect poller stop errors', async () => {
      const killSessionFn = vi.fn().mockResolvedValue(true);

      // Make stopResponsePolling throw for codex
      vi.mocked(stopResponsePolling).mockImplementation((worktreeId: string, cliToolId: CLIToolType) => {
        if (cliToolId === 'codex') {
          throw new Error('Poller stop failed');
        }
      });

      const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

      // At least one poller error should contain 'codex'
      expect(result.pollerErrors.length).toBeGreaterThanOrEqual(1);
      expect(result.pollerErrors.some(e => e.includes('codex'))).toBe(true);
    });

    it('should continue processing after individual errors', async () => {
      const killSessionFn = vi.fn()
        .mockRejectedValueOnce(new Error('Claude kill failed'))
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      const result = await cleanupWorktreeSessions('wt-1', killSessionFn);

      // Should still have processed all tools despite first error
      expect(killSessionFn).toHaveBeenCalledTimes(5);
      expect(result.sessionsKilled).toContain('codex');
      expect(result.sessionsKilled).toContain('gemini');
      expect(result.sessionsKilled).toContain('vibe-local');
      expect(result.sessionsKilled).toContain('opencode');
    });
  });

  describe('cleanupMultipleWorktrees', () => {
    it('should cleanup all worktrees', async () => {
      const killSessionFn = vi.fn().mockResolvedValue(true);
      const worktreeIds = ['wt-1', 'wt-2', 'wt-3'];

      const result = await cleanupMultipleWorktrees(worktreeIds, killSessionFn);

      expect(result.results).toHaveLength(3);
      // Each worktree should have 5 CLI tools killed
      expect(killSessionFn).toHaveBeenCalledTimes(15); // 3 worktrees * 5 CLI tools
    });

    it('should aggregate all warnings', async () => {
      const killSessionFn = vi.fn()
        .mockResolvedValueOnce(true)
        .mockRejectedValueOnce(new Error('Error 1'))
        .mockResolvedValue(true);

      const result = await cleanupMultipleWorktrees(['wt-1', 'wt-2'], killSessionFn);

      expect(result.warnings.length).toBeGreaterThan(0);
    });

    it('should return empty results for empty worktree list', async () => {
      const killSessionFn = vi.fn();

      const result = await cleanupMultipleWorktrees([], killSessionFn);

      expect(result.results).toHaveLength(0);
      expect(result.warnings).toHaveLength(0);
      expect(killSessionFn).not.toHaveBeenCalled();
    });
  });

  // Issue #526: killWorktreeSession() tests
  describe('killWorktreeSession', () => {
    it('should kill a running session and return true', async () => {
      const mockTool = {
        isRunning: vi.fn().mockResolvedValue(true),
        getSessionName: vi.fn().mockReturnValue('claude-wt-1'),
      };
      vi.mocked(CLIToolManager.getInstance().getTool).mockReturnValue(mockTool as any);
      vi.mocked(killSession).mockResolvedValue(true);

      const result = await killWorktreeSession('wt-1', 'claude');

      expect(result).toBe(true);
      expect(mockTool.isRunning).toHaveBeenCalledWith('wt-1');
      expect(mockTool.getSessionName).toHaveBeenCalledWith('wt-1');
      expect(killSession).toHaveBeenCalledWith('claude-wt-1');
    });

    it('should return false when session is not running', async () => {
      const mockTool = {
        isRunning: vi.fn().mockResolvedValue(false),
        getSessionName: vi.fn(),
      };
      vi.mocked(CLIToolManager.getInstance().getTool).mockReturnValue(mockTool as any);

      const result = await killWorktreeSession('wt-1', 'claude');

      expect(result).toBe(false);
      expect(killSession).not.toHaveBeenCalled();
    });

    it('should return false when getTool throws (tool not found)', async () => {
      vi.mocked(CLIToolManager.getInstance().getTool).mockImplementation(() => {
        throw new Error("CLI tool 'unknown' not found");
      });

      const result = await killWorktreeSession('wt-1', 'claude');

      expect(result).toBe(false);
    });
  });

  // Issue #526: syncWorktreesAndCleanup() tests
  describe('syncWorktreesAndCleanup', () => {
    const mockDb = {} as any;
    const mockWorktrees = [
      { id: 'wt-1', name: 'main', path: '/path', repositoryPath: '/repo', repositoryName: 'repo' },
    ] as any[];

    it('should call syncWorktreesToDB and return result when no deletions', async () => {
      vi.mocked(syncWorktreesToDB).mockReturnValue({ deletedIds: [], upsertedCount: 1 });

      const result = await syncWorktreesAndCleanup(mockDb, mockWorktrees);

      expect(syncWorktreesToDB).toHaveBeenCalledWith(mockDb, mockWorktrees);
      expect(result.syncResult.deletedIds).toEqual([]);
      expect(result.syncResult.upsertedCount).toBe(1);
      expect(result.cleanupWarnings).toEqual([]);
    });

    it('should trigger cleanup when deletedIds is non-empty', async () => {
      vi.mocked(syncWorktreesToDB).mockReturnValue({ deletedIds: ['wt-deleted'], upsertedCount: 1 });
      // killWorktreeSession is used internally, mock CLIToolManager to return non-running
      const mockTool = {
        isRunning: vi.fn().mockResolvedValue(false),
        getSessionName: vi.fn(),
      };
      vi.mocked(CLIToolManager.getInstance().getTool).mockReturnValue(mockTool as any);

      const result = await syncWorktreesAndCleanup(mockDb, mockWorktrees);

      expect(result.syncResult.deletedIds).toEqual(['wt-deleted']);
      // cleanupWarnings should be empty or contain only sanitized messages
      for (const warning of result.cleanupWarnings) {
        expect(warning).not.toContain('/'); // SEC-MF-001: no file paths
        expect(warning).not.toContain('Error:'); // no raw error messages
      }
    });

    it('should return sanitized warnings when cleanup fails', async () => {
      vi.mocked(syncWorktreesToDB).mockReturnValue({ deletedIds: ['wt-fail'], upsertedCount: 0 });
      // Make getTool throw to simulate session kill errors
      vi.mocked(CLIToolManager.getInstance().getTool).mockImplementation(() => {
        throw new Error('Internal error: /path/to/secret');
      });

      const result = await syncWorktreesAndCleanup(mockDb, mockWorktrees);

      // SEC-MF-001: cleanupWarnings should be sanitized (generic message, not internal details)
      expect(result.syncResult.deletedIds).toEqual(['wt-fail']);
      // Warnings should not contain internal path details
      for (const warning of result.cleanupWarnings) {
        expect(warning).not.toContain('/path/to/secret');
      }
    });

    it('should return syncResult even if cleanupMultipleWorktrees throws', async () => {
      vi.mocked(syncWorktreesToDB).mockReturnValue({ deletedIds: ['wt-error'], upsertedCount: 0 });
      // Mock a scenario where cleanup itself throws unexpectedly
      vi.mocked(CLIToolManager.getInstance().getTool).mockImplementation(() => {
        throw new Error('Unexpected crash');
      });

      const result = await syncWorktreesAndCleanup(mockDb, mockWorktrees);

      // sync result should still be present
      expect(result.syncResult.deletedIds).toEqual(['wt-error']);
      expect(result.syncResult.upsertedCount).toBe(0);
    });
  });
});
