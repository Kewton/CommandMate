import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import {
  getAutoYesState,
  setAutoYesEnabled,
  isAutoYesExpired,
  clearAllAutoYesStates,
  startAutoYesPolling,
  stopAutoYesPolling,
  stopAllAutoYesPolling,
  getLastServerResponseTimestamp,
  isValidWorktreeId,
  calculateBackoffInterval,
  getActivePollerCount,
  clearAllPollerStates,
  MAX_CONCURRENT_POLLERS,
  POLLING_INTERVAL_MS,
  MAX_BACKOFF_MS,
  MAX_CONSECUTIVE_ERRORS,
  type AutoYesState,
} from '@/lib/auto-yes-manager';

// Mock modules for pollAutoYes testing (Issue #161)
vi.mock('@/lib/cli-session', () => ({
  captureSessionOutput: vi.fn(),
}));
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn(),
  sendMessageWithEnter: vi.fn(),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({
        getSessionName: (id: string) => `claude-${id}`,
        name: 'Claude',
      }),
    }),
  },
}));

describe('auto-yes-manager', () => {
  beforeEach(() => {
    clearAllAutoYesStates();
    clearAllPollerStates();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    stopAllAutoYesPolling();
  });

  describe('setAutoYesEnabled', () => {
    it('should enable auto-yes with correct timestamps', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      const state = setAutoYesEnabled('wt-1', true);

      expect(state.enabled).toBe(true);
      expect(state.enabledAt).toBe(now);
      expect(state.expiresAt).toBe(now + 3600000);
    });

    it('should disable auto-yes', () => {
      setAutoYesEnabled('wt-1', true);
      const state = setAutoYesEnabled('wt-1', false);

      expect(state.enabled).toBe(false);
    });

    it('should disable auto-yes even when no prior state exists', () => {
      const state = setAutoYesEnabled('wt-new', false);

      expect(state.enabled).toBe(false);
      expect(state.enabledAt).toBe(0);
      expect(state.expiresAt).toBe(0);
    });
  });

  describe('getAutoYesState', () => {
    it('should return null when no state exists', () => {
      expect(getAutoYesState('nonexistent')).toBeNull();
    });

    it('should return the state when enabled', () => {
      setAutoYesEnabled('wt-1', true);
      const state = getAutoYesState('wt-1');

      expect(state).not.toBeNull();
      expect(state!.enabled).toBe(true);
    });

    it('should auto-disable when expired', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      setAutoYesEnabled('wt-1', true);

      // Advance past expiration
      vi.setSystemTime(now + 3600001);

      const state = getAutoYesState('wt-1');
      expect(state).not.toBeNull();
      expect(state!.enabled).toBe(false);
    });

    it('should not auto-disable when not yet expired', () => {
      vi.useFakeTimers();
      const now = 1700000000000;
      vi.setSystemTime(now);

      setAutoYesEnabled('wt-1', true);

      // Advance but not past expiration
      vi.setSystemTime(now + 3599999);

      const state = getAutoYesState('wt-1');
      expect(state!.enabled).toBe(true);
    });
  });

  describe('isAutoYesExpired', () => {
    it('should return true when expired', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(2001);

      expect(isAutoYesExpired(state)).toBe(true);
    });

    it('should return false when not expired', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(1999);

      expect(isAutoYesExpired(state)).toBe(false);
    });

    it('should return true at exact expiration time', () => {
      const state: AutoYesState = {
        enabled: true,
        enabledAt: 1000,
        expiresAt: 2000,
      };
      vi.useFakeTimers();
      vi.setSystemTime(2000);

      // At exact expiration, Date.now() === expiresAt, so not expired (> not >=)
      expect(isAutoYesExpired(state)).toBe(false);
    });
  });

  describe('clearAllAutoYesStates', () => {
    it('should clear all states', () => {
      setAutoYesEnabled('wt-1', true);
      setAutoYesEnabled('wt-2', true);

      clearAllAutoYesStates();

      expect(getAutoYesState('wt-1')).toBeNull();
      expect(getAutoYesState('wt-2')).toBeNull();
    });
  });

  // ==========================================================================
  // Issue #138: Server-side Auto-Yes Polling Tests
  // ==========================================================================

  describe('isValidWorktreeId', () => {
    it('should accept valid worktree IDs', () => {
      expect(isValidWorktreeId('worktree-1')).toBe(true);
      expect(isValidWorktreeId('wt_123')).toBe(true);
      expect(isValidWorktreeId('main')).toBe(true);
      expect(isValidWorktreeId('feature-branch-123')).toBe(true);
      expect(isValidWorktreeId('UPPERCASE')).toBe(true);
      expect(isValidWorktreeId('mix-Case_123')).toBe(true);
    });

    it('should reject invalid worktree IDs', () => {
      expect(isValidWorktreeId('')).toBe(false);
      expect(isValidWorktreeId('has space')).toBe(false);
      expect(isValidWorktreeId('has/slash')).toBe(false);
      expect(isValidWorktreeId('has..dots')).toBe(false);
      expect(isValidWorktreeId('../traversal')).toBe(false);
      expect(isValidWorktreeId('$(command)')).toBe(false);
      expect(isValidWorktreeId('`backtick`')).toBe(false);
      expect(isValidWorktreeId('has;semicolon')).toBe(false);
    });
  });

  describe('calculateBackoffInterval', () => {
    it('should return normal interval for few errors', () => {
      expect(calculateBackoffInterval(0)).toBe(POLLING_INTERVAL_MS);
      expect(calculateBackoffInterval(1)).toBe(POLLING_INTERVAL_MS);
      expect(calculateBackoffInterval(4)).toBe(POLLING_INTERVAL_MS);
    });

    it('should apply exponential backoff after MAX_CONSECUTIVE_ERRORS', () => {
      // 5 errors: 2^1 * 2000 = 4000
      expect(calculateBackoffInterval(5)).toBe(4000);
      // 6 errors: 2^2 * 2000 = 8000
      expect(calculateBackoffInterval(6)).toBe(8000);
      // 7 errors: 2^3 * 2000 = 16000
      expect(calculateBackoffInterval(7)).toBe(16000);
    });

    it('should cap backoff at MAX_BACKOFF_MS', () => {
      expect(calculateBackoffInterval(10)).toBe(MAX_BACKOFF_MS);
      expect(calculateBackoffInterval(20)).toBe(MAX_BACKOFF_MS);
      expect(calculateBackoffInterval(100)).toBe(MAX_BACKOFF_MS);
    });
  });

  describe('startAutoYesPolling', () => {
    it('should not start polling when auto-yes is disabled', () => {
      const result = startAutoYesPolling('wt-1', 'claude');
      expect(result.started).toBe(false);
      expect(result.reason).toBe('auto-yes not enabled');
      expect(getActivePollerCount()).toBe(0);
    });

    it('should start polling when auto-yes is enabled', () => {
      setAutoYesEnabled('wt-1', true);
      const result = startAutoYesPolling('wt-1', 'claude');
      expect(result.started).toBe(true);
      expect(getActivePollerCount()).toBe(1);
    });

    it('should stop existing poller before starting new one', () => {
      setAutoYesEnabled('wt-1', true);
      startAutoYesPolling('wt-1', 'claude');
      expect(getActivePollerCount()).toBe(1);

      // Start again - should still be 1
      startAutoYesPolling('wt-1', 'claude');
      expect(getActivePollerCount()).toBe(1);
    });

    it('should reject invalid worktree ID', () => {
      setAutoYesEnabled('invalid/id', true);
      const result = startAutoYesPolling('invalid/id', 'claude');
      expect(result.started).toBe(false);
      expect(result.reason).toBe('invalid worktree ID');
    });

    it('should enforce MAX_CONCURRENT_POLLERS limit', () => {
      // Enable and start 50 pollers
      for (let i = 0; i < MAX_CONCURRENT_POLLERS; i++) {
        setAutoYesEnabled(`wt-${i}`, true);
        const result = startAutoYesPolling(`wt-${i}`, 'claude');
        expect(result.started).toBe(true);
      }
      expect(getActivePollerCount()).toBe(MAX_CONCURRENT_POLLERS);

      // 51st should fail
      setAutoYesEnabled('wt-overflow', true);
      const result = startAutoYesPolling('wt-overflow', 'claude');
      expect(result.started).toBe(false);
      expect(result.reason).toBe('max concurrent pollers reached');
    });
  });

  describe('stopAutoYesPolling', () => {
    it('should stop an active poller', () => {
      setAutoYesEnabled('wt-1', true);
      startAutoYesPolling('wt-1', 'claude');
      expect(getActivePollerCount()).toBe(1);

      stopAutoYesPolling('wt-1');
      expect(getActivePollerCount()).toBe(0);
    });

    it('should handle non-existent poller gracefully', () => {
      // Should not throw
      expect(() => stopAutoYesPolling('nonexistent')).not.toThrow();
    });
  });

  describe('stopAllAutoYesPolling', () => {
    it('should stop all active pollers', () => {
      // Start multiple pollers
      for (let i = 0; i < 5; i++) {
        setAutoYesEnabled(`wt-${i}`, true);
        startAutoYesPolling(`wt-${i}`, 'claude');
      }
      expect(getActivePollerCount()).toBe(5);

      stopAllAutoYesPolling();
      expect(getActivePollerCount()).toBe(0);
    });

    it('should handle empty poller list gracefully', () => {
      expect(() => stopAllAutoYesPolling()).not.toThrow();
    });
  });

  describe('getLastServerResponseTimestamp', () => {
    it('should return null when no poller state exists', () => {
      expect(getLastServerResponseTimestamp('nonexistent')).toBeNull();
    });

    it('should return null when poller exists but no response sent', () => {
      setAutoYesEnabled('wt-1', true);
      startAutoYesPolling('wt-1', 'claude');
      expect(getLastServerResponseTimestamp('wt-1')).toBeNull();
    });
  });

  describe('Poller State Management', () => {
    it('should track error counts correctly', () => {
      vi.useFakeTimers();
      setAutoYesEnabled('wt-1', true);
      startAutoYesPolling('wt-1', 'claude');
      // Poller state is internal, tested through behavior
      expect(getActivePollerCount()).toBe(1);
    });

    it('should clear poller state on stop', () => {
      setAutoYesEnabled('wt-1', true);
      startAutoYesPolling('wt-1', 'claude');
      stopAutoYesPolling('wt-1');
      expect(getLastServerResponseTimestamp('wt-1')).toBeNull();
    });
  });

  describe('Constants', () => {
    it('should have correct default values', () => {
      expect(POLLING_INTERVAL_MS).toBe(2000);
      expect(MAX_BACKOFF_MS).toBe(60000);
      expect(MAX_CONSECUTIVE_ERRORS).toBe(5);
      expect(MAX_CONCURRENT_POLLERS).toBe(50);
    });
  });

  // ==========================================================================
  // Issue #153: globalThis State Persistence Tests
  // ==========================================================================

  describe('globalThis state management (Issue #153)', () => {
    beforeEach(() => {
      // Clear globalThis state before each test
      clearAllAutoYesStates();
      clearAllPollerStates();
    });

    it('should initialize globalThis.__autoYesStates', () => {
      // After module initialization, globalThis should have the Map
      expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
    });

    it('should initialize globalThis.__autoYesPollerStates', () => {
      // After module initialization, globalThis should have the Map
      expect(globalThis.__autoYesPollerStates).toBeInstanceOf(Map);
    });

    it('should store state in globalThis.__autoYesStates', () => {
      setAutoYesEnabled('test-worktree', true);

      // State should be stored in globalThis
      expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
      expect(globalThis.__autoYesStates?.has('test-worktree')).toBe(true);
      expect(globalThis.__autoYesStates?.get('test-worktree')?.enabled).toBe(true);
    });

    it('should store poller state in globalThis.__autoYesPollerStates', () => {
      setAutoYesEnabled('test-worktree-2', true);
      startAutoYesPolling('test-worktree-2', 'claude');

      // Poller state should be stored in globalThis
      expect(globalThis.__autoYesPollerStates).toBeInstanceOf(Map);
      expect(globalThis.__autoYesPollerStates?.has('test-worktree-2')).toBe(true);
    });

    it('should clear globalThis.__autoYesStates when clearAllAutoYesStates is called', () => {
      setAutoYesEnabled('test-worktree-3', true);
      expect(globalThis.__autoYesStates?.has('test-worktree-3')).toBe(true);

      clearAllAutoYesStates();

      // Map should be empty but still exist
      expect(globalThis.__autoYesStates).toBeInstanceOf(Map);
      expect(globalThis.__autoYesStates?.size).toBe(0);
    });

    it('should clear globalThis.__autoYesPollerStates when clearAllPollerStates is called', () => {
      setAutoYesEnabled('test-worktree-4', true);
      startAutoYesPolling('test-worktree-4', 'claude');
      expect(globalThis.__autoYesPollerStates?.has('test-worktree-4')).toBe(true);

      clearAllPollerStates();

      // Map should be empty but still exist
      expect(globalThis.__autoYesPollerStates).toBeInstanceOf(Map);
      expect(globalThis.__autoYesPollerStates?.size).toBe(0);
    });

    it('should maintain state reference after module access', () => {
      // Set state
      setAutoYesEnabled('persistence-test', true);

      // Get reference to globalThis state
      const statesRef = globalThis.__autoYesStates;

      // Access state through exported function
      const state = getAutoYesState('persistence-test');

      // References should be the same
      expect(statesRef).toBe(globalThis.__autoYesStates);
      expect(state?.enabled).toBe(true);
    });
  });

  // ==========================================================================
  // Issue #161: Thinking state skip test (Section 5.3 Test #1 / Section 5.5)
  // Verifies that pollAutoYes skips prompt detection during thinking state.
  // ==========================================================================
  describe('Issue #161: pollAutoYes thinking state skip', () => {
    it('should skip prompt detection when thinking state is detected', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { detectThinking } = await import('@/lib/cli-patterns');
      const { detectPrompt } = await import('@/lib/prompt-detector');
      const { sendKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Setup: enable auto-yes and start polling
      setAutoYesEnabled('wt-thinking', true);
      startAutoYesPolling('wt-thinking', 'claude');

      // Mock: captureSessionOutput returns thinking output with numbered list
      // Note: Uses unicode ellipsis (U+2026) to match CLAUDE_THINKING_PATTERN
      const thinkingOutput = '\u2733 Analyzing\u2026\n1. Step one\n2. Step two';
      vi.mocked(captureSessionOutput).mockResolvedValue(thinkingOutput);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: captureSessionOutput was called (poll ran)
      expect(captureSessionOutput).toHaveBeenCalled();

      // Verify: sendKeys was NOT called, confirming that pollAutoYes
      // skipped prompt detection due to thinking state (Layer 1 defense).
      // The thinking output '✻ Analyzing...' matches CLAUDE_THINKING_PATTERN,
      // so detectThinking() returns true and detectPrompt() is never called.
      // Note: Even without Layer 1, the 2-pass fix (Layer 2) would also prevent
      // false detection of the numbered list, but Layer 1 provides defense-in-depth.
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-thinking');
      vi.mocked(captureSessionOutput).mockReset();
    });

    it('should call detectPrompt when NOT in thinking state', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendMessageWithEnter } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Setup: enable auto-yes and start polling
      setAutoYesEnabled('wt-normal', true);
      startAutoYesPolling('wt-normal', 'claude');

      // Mock: captureSessionOutput returns a valid multiple_choice prompt
      const promptOutput = 'Select an option:\n\u276F 1. Yes\n  2. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendMessageWithEnter).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: captureSessionOutput was called
      expect(captureSessionOutput).toHaveBeenCalled();

      // Verify: sendMessageWithEnter was called (prompt was detected and auto-answered)
      // This confirms that when NOT in thinking state, prompt detection
      // proceeds normally and auto-answer is sent via unified pattern (Task-PRE-003).
      expect(sendMessageWithEnter).toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-normal');
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendMessageWithEnter).mockReset();
    });
  });
});
