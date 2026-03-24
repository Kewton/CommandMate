/**
 * Resource Cleanup tests
 * Issue #404: MCP orphaned process cleanup and globalThis Map memory leak prevention
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock child_process
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

// Mock fs for container detection
vi.mock('fs', () => ({
  existsSync: vi.fn().mockReturnValue(false),
}));

// Mock auto-yes-manager (Issue #525: includes extractWorktreeId)
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesStateCompositeKeys: vi.fn().mockReturnValue([]),
  getAutoYesPollerCompositeKeys: vi.fn().mockReturnValue([]),
  deleteAutoYesState: vi.fn().mockReturnValue(true),
  stopAutoYesPolling: vi.fn(),
  extractWorktreeId: vi.fn().mockImplementation((compositeKey: string) => {
    const lastIndex = compositeKey.lastIndexOf(':');
    return lastIndex === -1 ? compositeKey : compositeKey.substring(0, lastIndex);
  }),
}));

// Mock schedule-manager
vi.mock('@/lib/schedule-manager', () => ({
  stopScheduleForWorktree: vi.fn(),
  getActiveScheduleCount: vi.fn().mockReturnValue(0),
  getScheduleWorktreeIds: vi.fn().mockReturnValue([]),
}));

// Mock timer-manager (Issue #534)
vi.mock('@/lib/timer-manager', () => ({
  stopTimersForWorktree: vi.fn(),
  getTimerWorktreeIds: vi.fn().mockReturnValue(new Set()),
}));

// Mock response-poller
vi.mock('@/lib/polling/response-poller', () => ({
  getActivePollers: vi.fn().mockReturnValue([]),
  stopPolling: vi.fn(),
}));

// Mock db-instance
const mockDbAll = vi.fn().mockReturnValue([]);
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => ({
    prepare: vi.fn().mockReturnValue({
      all: mockDbAll,
    }),
  })),
}));

import {
  initResourceCleanup,
  stopResourceCleanup,
  cleanupOrphanedMapEntries,
  cleanupOrphanedMcpProcesses,
  CLEANUP_INTERVAL_MS,
  MCP_PROCESS_PATTERNS,
  MAX_PS_OUTPUT_BYTES,
} from '@/lib/resource-cleanup';
import { getAutoYesStateCompositeKeys, getAutoYesPollerCompositeKeys, deleteAutoYesState, stopAutoYesPolling, extractWorktreeId } from '@/lib/polling/auto-yes-manager';
import { stopScheduleForWorktree, getScheduleWorktreeIds } from '@/lib/schedule-manager';
import { execFile } from 'child_process';
import { existsSync } from 'fs';

describe('Resource Cleanup (Issue #404)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset global state
    (globalThis as Record<string, unknown>).__resourceCleanupTimerId = undefined;
  });

  afterEach(() => {
    stopResourceCleanup();
    vi.useRealTimers();
  });

  describe('Constants', () => {
    it('should have CLEANUP_INTERVAL_MS set to 24 hours', () => {
      expect(CLEANUP_INTERVAL_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('should have MCP_PROCESS_PATTERNS with expected patterns', () => {
      expect(MCP_PROCESS_PATTERNS).toContain('codex mcp-server');
      expect(MCP_PROCESS_PATTERNS).toContain('playwright-mcp');
    });

    it('should have MAX_PS_OUTPUT_BYTES set to 1MB', () => {
      expect(MAX_PS_OUTPUT_BYTES).toBe(1 * 1024 * 1024);
    });
  });

  describe('initResourceCleanup', () => {
    it('should start a timer', () => {
      initResourceCleanup();

      expect((globalThis as Record<string, unknown>).__resourceCleanupTimerId).toBeDefined();
    });

    it('should prevent duplicate timers on repeated calls', () => {
      initResourceCleanup();
      const firstTimerId = (globalThis as Record<string, unknown>).__resourceCleanupTimerId;

      initResourceCleanup();
      const secondTimerId = (globalThis as Record<string, unknown>).__resourceCleanupTimerId;

      // Should be the same timer (not a new one)
      expect(secondTimerId).toBe(firstTimerId);
    });
  });

  describe('stopResourceCleanup', () => {
    it('should stop the timer', () => {
      initResourceCleanup();
      expect((globalThis as Record<string, unknown>).__resourceCleanupTimerId).toBeDefined();

      stopResourceCleanup();

      expect((globalThis as Record<string, unknown>).__resourceCleanupTimerId).toBeUndefined();
    });

    it('should not throw when called without init', () => {
      expect(() => stopResourceCleanup()).not.toThrow();
    });
  });

  describe('cleanupOrphanedMapEntries', () => {
    it('should detect and remove orphaned entries from autoYesStates (composite keys)', () => {
      // Arrange: auto-yes state for worktree 'wt-orphan' (not in DB) using composite keys
      vi.mocked(getAutoYesStateCompositeKeys).mockReturnValue(['wt-orphan:claude', 'wt-valid:claude']);
      vi.mocked(getAutoYesPollerCompositeKeys).mockReturnValue([]);
      // DB returns only 'wt-valid'
      mockDbAll.mockReturnValue([{ id: 'wt-valid' }]);

      // Act
      const result = cleanupOrphanedMapEntries();

      // Assert
      expect(deleteAutoYesState).toHaveBeenCalledWith('wt-orphan:claude');
      expect(deleteAutoYesState).not.toHaveBeenCalledWith('wt-valid:claude');
      expect(result.deletedAutoYesStateIds).toContain('wt-orphan:claude');
      expect(result.deletedAutoYesStateIds).not.toContain('wt-valid:claude');
    });

    it('should detect and remove orphaned entries from autoYesPollerStates (composite keys)', () => {
      vi.mocked(getAutoYesStateCompositeKeys).mockReturnValue([]);
      vi.mocked(getAutoYesPollerCompositeKeys).mockReturnValue(['wt-orphan-poller:claude', 'wt-valid:codex']);
      mockDbAll.mockReturnValue([{ id: 'wt-valid' }]);

      const result = cleanupOrphanedMapEntries();

      expect(stopAutoYesPolling).toHaveBeenCalledWith('wt-orphan-poller:claude');
      expect(result.deletedAutoYesPollerIds).toContain('wt-orphan-poller:claude');
    });

    it('should not delete entries for valid worktrees', () => {
      vi.mocked(getAutoYesStateCompositeKeys).mockReturnValue(['wt-valid-1:claude', 'wt-valid-2:codex']);
      vi.mocked(getAutoYesPollerCompositeKeys).mockReturnValue(['wt-valid-1:claude']);
      mockDbAll.mockReturnValue([{ id: 'wt-valid-1' }, { id: 'wt-valid-2' }]);

      const result = cleanupOrphanedMapEntries();

      expect(deleteAutoYesState).not.toHaveBeenCalled();
      expect(stopAutoYesPolling).not.toHaveBeenCalled();
      expect(result.deletedAutoYesStateIds).toHaveLength(0);
      expect(result.deletedAutoYesPollerIds).toHaveLength(0);
    });

    it('should also cleanup orphaned schedule entries', () => {
      vi.mocked(getAutoYesStateCompositeKeys).mockReturnValue([]);
      vi.mocked(getAutoYesPollerCompositeKeys).mockReturnValue([]);
      mockDbAll.mockReturnValue([{ id: 'wt-valid' }]);

      // Mock getScheduleWorktreeIds to return an orphaned worktree ID
      vi.mocked(getScheduleWorktreeIds).mockReturnValue(['wt-orphan-sched']);

      const result = cleanupOrphanedMapEntries();

      expect(stopScheduleForWorktree).toHaveBeenCalledWith('wt-orphan-sched');
      expect(result.deletedScheduleWorktreeIds).toContain('wt-orphan-sched');
    });
  });

  describe('cleanupOrphanedMcpProcesses', () => {
    it('should skip execution in container environments', async () => {
      vi.mocked(existsSync).mockReturnValue(true); // /proc/1/cgroup exists

      const result = await cleanupOrphanedMcpProcesses();

      expect(execFile).not.toHaveBeenCalled();
      expect(result.skipped).toBe(true);
      expect(result.reason).toBe('container');
    });

    it('should call execFile with ps command on non-container environments', async () => {
      vi.mocked(existsSync).mockReturnValue(false);
      vi.mocked(execFile).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          cb(null, '');
        }) as unknown as typeof execFile
      );

      await cleanupOrphanedMcpProcesses();

      expect(execFile).toHaveBeenCalled();
    });

    it('should parse ps output and kill orphaned MCP processes', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      // Simulate ps output with orphaned MCP processes (ppid=1)
      const psOutput = [
        '  PID  PPID COMMAND',
        '  123     1 node /path/to/codex mcp-server',
        '  456     1 node /path/to/playwright-mcp',
        '  789   100 node /path/to/codex mcp-server',  // Not orphaned (ppid != 1)
      ].join('\n');

      vi.mocked(execFile).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          cb(null, psOutput);
        }) as unknown as typeof execFile
      );

      // Mock process.kill
      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const result = await cleanupOrphanedMcpProcesses();

      // Should only kill processes with ppid=1 matching MCP patterns
      expect(killSpy).toHaveBeenCalledWith(123, 'SIGTERM');
      expect(killSpy).toHaveBeenCalledWith(456, 'SIGTERM');
      expect(killSpy).not.toHaveBeenCalledWith(789, 'SIGTERM');
      expect(result.killedPids).toContain(123);
      expect(result.killedPids).toContain(456);

      killSpy.mockRestore();
    });

    it('should validate PID values from ps output', async () => {
      vi.mocked(existsSync).mockReturnValue(false);

      const psOutput = [
        '  PID  PPID COMMAND',
        '  -1     1 node codex mcp-server',  // Invalid: negative
        '  0      1 node playwright-mcp',     // Invalid: zero
        '  abc    1 node codex mcp-server',   // Invalid: not a number
      ].join('\n');

      vi.mocked(execFile).mockImplementation(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        ((_cmd: string, _args: string[], _opts: unknown, cb: (err: Error | null, stdout: string) => void) => {
          cb(null, psOutput);
        }) as unknown as typeof execFile
      );

      const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => true);

      const result = await cleanupOrphanedMcpProcesses();

      // Should not kill any processes with invalid PIDs
      expect(killSpy).not.toHaveBeenCalled();
      expect(result.killedPids).toHaveLength(0);

      killSpy.mockRestore();
    });
  });
});
