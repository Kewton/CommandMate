/**
 * Session cleanup utility unit tests
 * Issue #69: Repository delete feature
 * TDD Approach: Write tests first (Red), then implement (Green), then refactor
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock response-poller before importing
vi.mock('@/lib/response-poller', () => ({
  stopPolling: vi.fn(),
}));

// Import after mocking
import {
  cleanupWorktreeSessions,
  cleanupMultipleWorktrees,
  type WorktreeCleanupResult,
} from '@/lib/session-cleanup';
import { stopPolling as stopResponsePolling } from '@/lib/response-poller';

describe('Session Cleanup Utility', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

      expect(result.pollerErrors).toHaveLength(1);
      expect(result.pollerErrors[0]).toContain('codex');
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
});
