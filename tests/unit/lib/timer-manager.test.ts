/**
 * Tests for timer-manager.ts
 * Issue #534: Timer manager with globalThis pattern, setTimeout management
 * TDD Red Phase: Tests written before implementation
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger (inline to avoid hoisting issues)
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  })),
}));

// Mock db-instance
const mockDbPrepare = vi.fn();
const mockDb = {
  prepare: mockDbPrepare,
};
vi.mock('@/lib/db/db-instance', () => ({
  getDbInstance: vi.fn(() => mockDb),
}));

// Mock timer-db
const mockCreateTimer = vi.fn();
const mockGetTimerById = vi.fn();
const mockGetPendingTimers = vi.fn().mockReturnValue([]);
const mockUpdateTimerStatus = vi.fn();
const mockCancelTimer = vi.fn();
const mockCancelTimersByWorktree = vi.fn().mockReturnValue(0);
const mockCleanupOldTimers = vi.fn().mockReturnValue(0);
const mockRecoverStuckSendingTimers = vi.fn().mockReturnValue(0);

vi.mock('@/lib/db/timer-db', () => ({
  createTimer: (...args: unknown[]) => mockCreateTimer(...args),
  getTimerById: (...args: unknown[]) => mockGetTimerById(...args),
  getPendingTimers: (...args: unknown[]) => mockGetPendingTimers(...args),
  updateTimerStatus: (...args: unknown[]) => mockUpdateTimerStatus(...args),
  cancelTimer: (...args: unknown[]) => mockCancelTimer(...args),
  cancelTimersByWorktree: (...args: unknown[]) => mockCancelTimersByWorktree(...args),
  cleanupOldTimers: (...args: unknown[]) => mockCleanupOldTimers(...args),
  recoverStuckSendingTimers: (...args: unknown[]) => mockRecoverStuckSendingTimers(...args),
}));

// Mock CLIToolManager
// Issue #947: timer-manager now delegates sending to cliTool.sendMessage()
// (which performs the per-tool text/Enter separation) instead of calling tmux
// sendKeys() directly.
const mockGetTool = vi.fn();
const mockIsRunning = vi.fn().mockResolvedValue(true);
const mockSendMessage = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: vi.fn().mockReturnValue({
      getTool: (...args: unknown[]) => mockGetTool(...args),
    }),
  },
}));

// Import after mocking
import {
  initTimerManager,
  stopAllTimers,
  scheduleTimer,
  cancelScheduledTimer,
  stopTimersForWorktree,
  getActiveTimerCount,
  getTimerWorktreeIds,
} from '@/lib/timer-manager';

describe('timer-manager', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Reset globalThis state
    (globalThis as Record<string, unknown>).__timerManagerState = undefined;
  });

  afterEach(() => {
    stopAllTimers();
    vi.useRealTimers();
  });

  describe('initTimerManager', () => {
    it('should initialize and restore pending timers from DB', () => {
      const pendingTimers = [
        {
          id: 'timer-1',
          worktreeId: 'wt-1',
          cliToolId: 'claude',
          message: 'Test',
          delayMs: 300000,
          scheduledSendTime: Date.now() + 300000,
          status: 'pending',
          createdAt: Date.now(),
          sentAt: null,
        },
      ];
      mockGetPendingTimers.mockReturnValueOnce(pendingTimers);

      initTimerManager();

      expect(mockGetPendingTimers).toHaveBeenCalled();
      expect(getActiveTimerCount()).toBe(1);
    });

    it('should not initialize twice', () => {
      mockGetPendingTimers.mockReturnValue([]);

      initTimerManager();
      initTimerManager();

      expect(mockGetPendingTimers).toHaveBeenCalledTimes(1);
    });

    // Issue #540: cleanup on init
    it('should call cleanupOldTimers with TIMER_CLEANUP_RETENTION_DAYS on init', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);

      initTimerManager();

      expect(mockCleanupOldTimers).toHaveBeenCalledWith(expect.anything(), 30);
    });

    it('should call recoverStuckSendingTimers on init', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);

      initTimerManager();

      expect(mockRecoverStuckSendingTimers).toHaveBeenCalledWith(expect.anything());
    });
  });

  describe('stopAllTimers', () => {
    it('should clear all scheduled timers', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      initTimerManager();

      // Schedule a timer manually
      scheduleTimer('timer-1', 'wt-1', 300000);

      expect(getActiveTimerCount()).toBe(1);

      stopAllTimers();

      expect(getActiveTimerCount()).toBe(0);
    });

    it('should be safe to call when no timers exist', () => {
      expect(() => stopAllTimers()).not.toThrow();
    });
  });

  describe('scheduleTimer', () => {
    it('should add a timer to the active timers map', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      initTimerManager();

      scheduleTimer('timer-1', 'wt-1', 300000);

      expect(getActiveTimerCount()).toBe(1);
    });
  });

  describe('cancelScheduledTimer', () => {
    it('should remove a timer from the active map and update DB', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      mockCancelTimer.mockReturnValueOnce(true);
      initTimerManager();

      scheduleTimer('timer-1', 'wt-1', 300000);
      cancelScheduledTimer('timer-1');

      expect(getActiveTimerCount()).toBe(0);
      expect(mockCancelTimer).toHaveBeenCalled();
    });

    it('should be safe to cancel non-existent timer', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      initTimerManager();

      expect(() => cancelScheduledTimer('non-existent')).not.toThrow();
    });
  });

  describe('stopTimersForWorktree', () => {
    it('should cancel all timers for a specific worktree using in-memory map', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      initTimerManager();

      scheduleTimer('timer-1', 'wt-1', 300000);
      scheduleTimer('timer-2', 'wt-1', 600000);
      scheduleTimer('timer-3', 'wt-2', 300000);

      stopTimersForWorktree('wt-1');

      // timer-3 should remain
      expect(getActiveTimerCount()).toBe(1);
      expect(mockCancelTimersByWorktree).toHaveBeenCalledWith(expect.anything(), 'wt-1');
    });
  });

  describe('getActiveTimerCount', () => {
    it('should return 0 when no timers are active', () => {
      expect(getActiveTimerCount()).toBe(0);
    });
  });

  describe('getTimerWorktreeIds', () => {
    it('should return set of worktree IDs with active timers', () => {
      mockGetPendingTimers.mockReturnValueOnce([]);
      initTimerManager();

      scheduleTimer('timer-1', 'wt-1', 300000);
      scheduleTimer('timer-2', 'wt-2', 300000);

      const ids = getTimerWorktreeIds();
      expect(ids).toBeInstanceOf(Set);
      expect(ids.size).toBe(2);
      expect(ids.has('wt-1')).toBe(true);
      expect(ids.has('wt-2')).toBe(true);
    });
  });

  describe('executeTimer (via setTimeout callback)', () => {
    it('should send message and update status on success when session is running', async () => {
      const timerId = 'timer-exec-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        message: 'Hello',
        delayMs: 300000,
        scheduledSendTime: Date.now() + 300000,
        status: 'pending',
        createdAt: Date.now(),
        sentAt: null,
      };

      mockGetPendingTimers.mockReturnValueOnce([]);
      mockGetTimerById.mockReturnValue(timer);
      mockIsRunning.mockResolvedValue(true);
      mockGetTool.mockReturnValue({
        isRunning: mockIsRunning,
        sendMessage: mockSendMessage,
      });

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      // Advance timers to trigger callback
      await vi.advanceTimersByTimeAsync(200);

      expect(mockIsRunning).toHaveBeenCalledWith('wt-1', 'claude');
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'sending'
      );
      // Issue #947: delegates to cliTool.sendMessage (worktreeId, message,
      // instanceId) rather than calling tmux sendKeys directly.
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', 'Hello', 'claude');
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'sent',
        expect.any(Number)
      );
    });

    // Issue #942: route to the specific agent instance session
    it('should resolve the instance session when timer targets a non-primary instance', async () => {
      const timerId = 'timer-instance-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude-reviewer',
        message: 'Hello',
        delayMs: 300000,
        scheduledSendTime: Date.now() + 300000,
        status: 'pending',
        createdAt: Date.now(),
        sentAt: null,
      };

      mockGetPendingTimers.mockReturnValueOnce([]);
      mockGetTimerById.mockReturnValue(timer);
      mockIsRunning.mockResolvedValue(true);
      mockGetTool.mockReturnValue({
        isRunning: mockIsRunning,
        sendMessage: mockSendMessage,
      });

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      await vi.advanceTimersByTimeAsync(200);

      expect(mockIsRunning).toHaveBeenCalledWith('wt-1', 'claude-reviewer');
      // Issue #947: the instanceId is forwarded to sendMessage, which resolves
      // the instance session internally (same path as manual sends).
      expect(mockSendMessage).toHaveBeenCalledWith('wt-1', 'Hello', 'claude-reviewer');
    });

    it('should set status to no_session when session is not running', async () => {
      const timerId = 'timer-nosession-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        message: 'Hello',
        delayMs: 300000,
        scheduledSendTime: Date.now() + 300000,
        status: 'pending',
        createdAt: Date.now(),
        sentAt: null,
      };

      mockGetPendingTimers.mockReturnValueOnce([]);
      mockGetTimerById.mockReturnValue(timer);
      mockIsRunning.mockResolvedValue(false);
      mockGetTool.mockReturnValue({
        isRunning: mockIsRunning,
        sendMessage: mockSendMessage,
      });

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      await vi.advanceTimersByTimeAsync(200);

      expect(mockIsRunning).toHaveBeenCalledWith('wt-1', 'claude');
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'no_session'
      );
      // Should NOT attempt to send when no session is running
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it('should set status to failed on send error when session is running', async () => {
      const timerId = 'timer-fail-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
        instanceId: 'claude',
        message: 'Hello',
        delayMs: 300000,
        scheduledSendTime: Date.now() + 300000,
        status: 'pending',
        createdAt: Date.now(),
        sentAt: null,
      };

      mockGetPendingTimers.mockReturnValueOnce([]);
      mockGetTimerById.mockReturnValue(timer);
      mockIsRunning.mockResolvedValue(true);
      mockGetTool.mockReturnValue({
        isRunning: mockIsRunning,
        sendMessage: mockSendMessage,
      });
      mockSendMessage.mockRejectedValueOnce(new Error('tmux session not found'));

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      await vi.advanceTimersByTimeAsync(200);

      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'failed'
      );
    });
  });
});
