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
vi.mock('@/lib/db-instance', () => ({
  getDbInstance: vi.fn(() => mockDb),
}));

// Mock timer-db
const mockCreateTimer = vi.fn();
const mockGetTimerById = vi.fn();
const mockGetPendingTimers = vi.fn().mockReturnValue([]);
const mockUpdateTimerStatus = vi.fn();
const mockCancelTimer = vi.fn();
const mockCancelTimersByWorktree = vi.fn().mockReturnValue(0);

vi.mock('@/lib/db/timer-db', () => ({
  createTimer: (...args: unknown[]) => mockCreateTimer(...args),
  getTimerById: (...args: unknown[]) => mockGetTimerById(...args),
  getPendingTimers: (...args: unknown[]) => mockGetPendingTimers(...args),
  updateTimerStatus: (...args: unknown[]) => mockUpdateTimerStatus(...args),
  cancelTimer: (...args: unknown[]) => mockCancelTimer(...args),
  cancelTimersByWorktree: (...args: unknown[]) => mockCancelTimersByWorktree(...args),
}));

// Mock tmux sendKeys
const mockSendKeys = vi.fn().mockResolvedValue(undefined);
vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: (...args: unknown[]) => mockSendKeys(...args),
}));

// Mock CLIToolManager
const mockGetTool = vi.fn();
const mockIsRunning = vi.fn().mockResolvedValue(true);
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
        getSessionName: vi.fn().mockReturnValue('session-wt-1'),
        isRunning: mockIsRunning,
      });

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      // Advance timers to trigger callback
      await vi.advanceTimersByTimeAsync(200);

      expect(mockIsRunning).toHaveBeenCalledWith('wt-1');
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'sending'
      );
      expect(mockSendKeys).toHaveBeenCalledWith('session-wt-1', 'Hello', true);
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'sent',
        expect.any(Number)
      );
    });

    it('should set status to no_session when session is not running', async () => {
      const timerId = 'timer-nosession-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
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
        getSessionName: vi.fn().mockReturnValue('session-wt-1'),
        isRunning: mockIsRunning,
      });

      initTimerManager();
      scheduleTimer(timerId, 'wt-1', 100);

      await vi.advanceTimersByTimeAsync(200);

      expect(mockIsRunning).toHaveBeenCalledWith('wt-1');
      expect(mockUpdateTimerStatus).toHaveBeenCalledWith(
        expect.anything(),
        timerId,
        'no_session'
      );
      // Should NOT call sendKeys
      expect(mockSendKeys).not.toHaveBeenCalled();
    });

    it('should set status to failed on send error when session is running', async () => {
      const timerId = 'timer-fail-1';
      const timer = {
        id: timerId,
        worktreeId: 'wt-1',
        cliToolId: 'claude',
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
        getSessionName: vi.fn().mockReturnValue('session-wt-1'),
        isRunning: mockIsRunning,
      });
      mockSendKeys.mockRejectedValueOnce(new Error('tmux session not found'));

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
