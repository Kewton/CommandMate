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
  THINKING_CHECK_LINE_COUNT,
  type AutoYesState,
} from '@/lib/auto-yes-manager';

// Mock modules for pollAutoYes testing (Issue #161)
vi.mock('@/lib/cli-session', () => ({
  captureSessionOutput: vi.fn(),
}));
vi.mock('@/lib/tmux', () => ({
  sendKeys: vi.fn(),
  sendSpecialKeys: vi.fn(),
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
      const { sendSpecialKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Setup: enable auto-yes and start polling
      setAutoYesEnabled('wt-normal', true);
      startAutoYesPolling('wt-normal', 'claude');

      // Mock: captureSessionOutput returns a valid multiple_choice prompt
      const promptOutput = 'Select an option:\n\u276F 1. Yes\n  2. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: captureSessionOutput was called
      expect(captureSessionOutput).toHaveBeenCalled();

      // Verify: sendSpecialKeys was called (prompt was detected and auto-answered)
      // This confirms that when NOT in thinking state, prompt detection
      // proceeds normally and auto-answer is sent.
      // Issue #193: Claude multiple_choice prompts now use sendSpecialKeys
      // (cursor-based navigation) instead of sendKeys (text-based).
      expect(sendSpecialKeys).toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-normal');
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();
    });
  });

  // ==========================================================================
  // Issue #191: detectThinking windowing
  // Verifies that detectThinking() only scans the last THINKING_CHECK_LINE_COUNT
  // lines of the buffer, preventing stale thinking summary lines from blocking
  // prompt detection.
  // ==========================================================================
  describe('Issue #191: detectThinking windowing', () => {
    it('should detect prompt when stale thinking summary exists in early buffer lines (Issue #191)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Setup: enable auto-yes and start polling
      setAutoYesEnabled('wt-stale-thinking', true);
      startAutoYesPolling('wt-stale-thinking', 'claude');

      // 5000-line buffer:
      // - First 100 lines: stale thinking summary lines (would match CLAUDE_THINKING_PATTERN)
      // - Middle ~4890 lines: normal output
      // - Last 10 lines: yes/no prompt
      const staleThinkingLines = Array(100).fill('\u00B7 Simmering\u2026 (4m 16s \u00B7 \u2193 8.0k tokens \u00B7 thought for 53s)');
      const normalLines = Array(4890).fill('normal output line');
      const promptLines = [
        'Do you want to proceed?',
        '',
        '  Yes / No',
        '',
        'Do you want to proceed? (y/n)',
        '',
        '',
        '',
        '',
        '',
      ];
      const fullBuffer = [...staleThinkingLines, ...normalLines, ...promptLines].join('\n');

      vi.mocked(captureSessionOutput).mockResolvedValue(fullBuffer);
      vi.mocked(sendKeys).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: captureSessionOutput was called (poll ran)
      expect(captureSessionOutput).toHaveBeenCalled();

      // Verify: sendKeys WAS called, meaning the stale thinking lines did NOT
      // block prompt detection. Before Issue #191 fix, detectThinking() would
      // match the stale lines in the first 100 lines and skip prompt detection.
      expect(sendKeys).toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-stale-thinking');
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
    });

    it('should skip prompt detection when thinking pattern is within last 50 lines (Issue #191)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Setup: enable auto-yes and start polling
      setAutoYesEnabled('wt-recent-thinking', true);
      startAutoYesPolling('wt-recent-thinking', 'claude');

      // 5000-line buffer with thinking pattern within last 50 lines:
      // - First 4970 lines: normal output
      // - Line 4971: active thinking pattern (within last 30 lines of buffer)
      // - Last 29 lines: some output (no prompt)
      const normalLines = Array(4970).fill('normal output');
      const thinkingLine = '\u2733 Analyzing\u2026';
      const recentLines = Array(29).fill('some output');
      const fullBuffer = [...normalLines, thinkingLine, ...recentLines].join('\n');

      vi.mocked(captureSessionOutput).mockResolvedValue(fullBuffer);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: captureSessionOutput was called (poll ran)
      expect(captureSessionOutput).toHaveBeenCalled();

      // Verify: sendKeys was NOT called, confirming that thinking pattern
      // within the last 50 lines correctly blocks prompt detection.
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-recent-thinking');
      vi.mocked(captureSessionOutput).mockReset();
    });

    it('should have THINKING_CHECK_LINE_COUNT matching prompt-detector multiple_choice scan window (SF-001)', async () => {
      // SF-001: Verify that THINKING_CHECK_LINE_COUNT and prompt-detector.ts's
      // detectMultipleChoicePrompt() window size (50 lines) are consistent.
      // This ensures Issue #161 Layer 1 defense covers the same scope as prompt detection.
      //
      // Verification approach:
      // 1. Direct: Assert THINKING_CHECK_LINE_COUNT value
      // 2. Indirect: Create a buffer where a multiple_choice prompt is placed
      //    exactly at the Nth line from end (N = THINKING_CHECK_LINE_COUNT),
      //    verify detectPrompt detects it, confirming both windows are aligned.

      const { detectPrompt } = await import('@/lib/prompt-detector');

      // Part 1: Direct value assertion
      expect(THINKING_CHECK_LINE_COUNT).toBe(50);

      // Part 2: Indirect verification - place options at exactly the boundary
      // of detectMultipleChoicePrompt's scan window (last 50 lines).
      // The multiple_choice prompt options should be detectable at this boundary.
      const paddingLines = Array(100).fill('padding line');
      // Place options starting at line (total - 50) from end
      const optionLines = [
        'Do you want to proceed?',
        '\u276F 1. Yes',
        '  2. No',
      ];
      // Fill remaining lines to push options to exactly the 50-line boundary
      const trailingLines = Array(50 - optionLines.length).fill('');
      const buffer = [...paddingLines, ...optionLines, ...trailingLines].join('\n');

      const result = detectPrompt(buffer);

      // The prompt should be detected because the options fall within
      // the last 50 lines (matching THINKING_CHECK_LINE_COUNT scope).
      expect(result.isPrompt).toBe(true);
      expect(result.promptData?.type).toBe('multiple_choice');

      // Verify that options placed OUTSIDE the 50-line window are NOT detected
      const outsideOptionLines = [
        'Do you want to proceed?',
        '\u276F 1. Yes',
        '  2. No',
      ];
      const moreTrailingLines = Array(50).fill('trailing line');
      const outsideBuffer = [...paddingLines, ...outsideOptionLines, ...moreTrailingLines].join('\n');

      const outsideResult = detectPrompt(outsideBuffer);
      // Options are pushed outside the 50-line window, so should NOT be detected
      expect(outsideResult.isPrompt).toBe(false);
    });
  });

  // ==========================================================================
  // Issue #193: Cursor-based navigation for Claude Code multiple_choice prompts
  // Verifies that pollAutoYes sends Arrow/Enter keys via sendSpecialKeys()
  // for Claude Code multiple_choice prompts, instead of typing numbers via sendKeys().
  // ==========================================================================
  describe('Issue #193: Claude Code cursor-based navigation in pollAutoYes', () => {
    it('should call sendSpecialKeys for Claude multiple_choice prompt (not sendKeys)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup
      setAutoYesEnabled('wt-mc-claude', true);
      startAutoYesPolling('wt-mc-claude', 'claude');

      // Mock: captureSessionOutput returns a multiple_choice prompt with default on option 1
      const promptOutput = 'Select an option:\n\u276F 1. Yes\n  2. No\n  3. Cancel';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendSpecialKeys was called (cursor-based navigation)
      expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
      const specialKeysCall = vi.mocked(sendSpecialKeys).mock.calls[0];
      expect(specialKeysCall[0]).toBe('claude-wt-mc-claude'); // session name
      // resolveAutoAnswer picks default (option 1), cursor starts at default (1), offset=0
      // So just Enter is sent
      expect(specialKeysCall[1]).toEqual(['Enter']);

      // Verify: sendKeys was NOT called (no text-based sending for Claude multi-choice)
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-mc-claude');
    });

    it('should call sendKeys (not sendSpecialKeys) for Claude yes/no prompt', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup
      setAutoYesEnabled('wt-yn', true);
      startAutoYesPolling('wt-yn', 'claude');

      // Mock: captureSessionOutput returns a yes/no prompt
      const promptOutput = 'Do you want to proceed? (y/n)';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendKeys was called with 'y' (text-based for yes/no prompts)
      expect(sendKeys).toHaveBeenCalled();
      const firstCall = vi.mocked(sendKeys).mock.calls[0];
      expect(firstCall[1]).toBe('y'); // answer text

      // Verify: sendSpecialKeys was NOT called (yes/no uses text, not cursor)
      expect(sendSpecialKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-yn');
    });

    it('should call sendKeys (not sendSpecialKeys) for non-Claude (codex) multiple_choice prompt', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup: use 'codex' CLI tool
      setAutoYesEnabled('wt-codex-mc', true);
      startAutoYesPolling('wt-codex-mc', 'codex');

      // Mock: captureSessionOutput returns a multiple_choice prompt
      const promptOutput = 'Select an option:\n\u276F 1. Yes\n  2. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendKeys was called (text-based for non-Claude CLI tools)
      expect(sendKeys).toHaveBeenCalled();

      // Verify: sendSpecialKeys was NOT called (only Claude uses cursor navigation)
      expect(sendSpecialKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-codex-mc');
    });

    it('should calculate correct Down arrow offset (default=1, target=3 -> 2x Down + Enter)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');
      const autoYesResolver = await import('@/lib/auto-yes-resolver');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup
      setAutoYesEnabled('wt-offset-down', true);
      startAutoYesPolling('wt-offset-down', 'claude');

      // Mock: multiple_choice prompt with default on option 1
      const promptOutput = 'Select an option:\n\u276F 1. Yes\n  2. Maybe\n  3. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Mock resolveAutoAnswer to return '3' (target option 3, default is 1)
      vi.spyOn(autoYesResolver, 'resolveAutoAnswer').mockReturnValue('3');

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendSpecialKeys was called with 2x Down + Enter
      expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
      const specialKeysCall = vi.mocked(sendSpecialKeys).mock.calls[0];
      expect(specialKeysCall[1]).toEqual(['Down', 'Down', 'Enter']);

      // Verify: sendKeys was NOT called
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-offset-down');
      vi.mocked(autoYesResolver.resolveAutoAnswer).mockRestore();
    });

    it('should calculate correct Up arrow offset (default=3, target=1 -> 2x Up + Enter)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');
      const autoYesResolver = await import('@/lib/auto-yes-resolver');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup
      setAutoYesEnabled('wt-offset-up', true);
      startAutoYesPolling('wt-offset-up', 'claude');

      // Mock: multiple_choice prompt with default on option 3 (cursor indicator on 3)
      const promptOutput = 'Select an option:\n  1. Yes\n  2. Maybe\n\u276F 3. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Mock resolveAutoAnswer to return '1' (target option 1, default is 3)
      vi.spyOn(autoYesResolver, 'resolveAutoAnswer').mockReturnValue('1');

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendSpecialKeys was called with 2x Up + Enter
      expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
      const specialKeysCall = vi.mocked(sendSpecialKeys).mock.calls[0];
      expect(specialKeysCall[1]).toEqual(['Up', 'Up', 'Enter']);

      // Verify: sendKeys was NOT called
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-offset-up');
      vi.mocked(autoYesResolver.resolveAutoAnswer).mockRestore();
    });

    it('should send just Enter when default=target (offset=0)', async () => {
      const { captureSessionOutput } = await import('@/lib/cli-session');
      const { sendKeys, sendSpecialKeys } = await import('@/lib/tmux');
      const autoYesResolver = await import('@/lib/auto-yes-resolver');

      vi.useFakeTimers();
      const now = Date.now();
      vi.setSystemTime(now);

      // Clear all mock call history before this test
      vi.mocked(captureSessionOutput).mockReset();
      vi.mocked(sendKeys).mockReset();
      vi.mocked(sendSpecialKeys).mockReset();

      // Setup
      setAutoYesEnabled('wt-offset-zero', true);
      startAutoYesPolling('wt-offset-zero', 'claude');

      // Mock: multiple_choice prompt with default on option 2
      const promptOutput = 'Select an option:\n  1. Yes\n\u276F 2. Maybe\n  3. No';
      vi.mocked(captureSessionOutput).mockResolvedValue(promptOutput);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);

      // Mock resolveAutoAnswer to return '2' (target=2, default=2, offset=0)
      vi.spyOn(autoYesResolver, 'resolveAutoAnswer').mockReturnValue('2');

      // Advance timer to trigger pollAutoYes
      await vi.advanceTimersByTimeAsync(POLLING_INTERVAL_MS + 100);

      // Verify: sendSpecialKeys was called with just Enter (no arrow keys)
      expect(sendSpecialKeys).toHaveBeenCalledTimes(1);
      const specialKeysCall = vi.mocked(sendSpecialKeys).mock.calls[0];
      expect(specialKeysCall[1]).toEqual(['Enter']);

      // Verify: sendKeys was NOT called
      expect(sendKeys).not.toHaveBeenCalled();

      // Cleanup
      stopAutoYesPolling('wt-offset-zero');
      vi.mocked(autoYesResolver.resolveAutoAnswer).mockRestore();
    });
  });
});
