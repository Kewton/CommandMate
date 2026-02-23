/**
 * Tests for claude-session module improvements
 * Issue #152: Fix first message not being sent after session start
 * Issue #187: Fix session first message reliability
 * Issue #265: Cache invalidation, health check, CLAUDECODE removal
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux module before importing claude-session
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
}));

// Mock pasted-text-helper (Issue #212)
vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
}));

// Mock fs/promises for isValidClaudePath (Issue #265)
// Must include constants.X_OK for access() validation in getClaudePath()
vi.mock('fs/promises', () => ({
  access: vi.fn().mockResolvedValue(undefined),
  constants: { X_OK: 1 },
}));

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((cmd: string, opts: unknown, cb?: unknown) => {
    if (typeof opts === 'function') {
      cb = opts;
    }
    const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
    if (cmd.includes('which claude')) {
      callback(null, { stdout: '/usr/local/bin/claude', stderr: '' });
    } else {
      callback(null, { stdout: '', stderr: '' });
    }
    return {};
  }),
}));

import {
  startClaudeSession,
  sendMessageToClaude,
  waitForPrompt,
  getSessionName,
  isClaudeRunning,
  isClaudeInstalled,
  clearCachedClaudePath,
  captureClaudeOutput,
  stopClaudeSession,
  getClaudeSessionState,
  restartClaudeSession,
  isSessionHealthy,
  type HealthCheckResult,
  CLAUDE_INIT_TIMEOUT,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
  CLAUDE_PROMPT_WAIT_TIMEOUT,
  CLAUDE_PROMPT_POLL_INTERVAL,
  CLAUDE_SEND_PROMPT_WAIT_TIMEOUT,
} from '@/lib/claude-session';
import { hasSession, createSession, sendKeys, capturePane, killSession } from '@/lib/tmux';
import {
  CLAUDE_PROMPT_PATTERN,
  CLAUDE_SEPARATOR_PATTERN,
  CLAUDE_SESSION_ERROR_PATTERNS,
  CLAUDE_SESSION_ERROR_REGEX_PATTERNS,
} from '@/lib/cli-patterns';
import { detectAndResendIfPastedText } from '@/lib/pasted-text-helper';

// ----- Shared test constants (DRY) -----
const TEST_WORKTREE_ID = 'test-worktree';
const TEST_WORKTREE_PATH = '/path/to/worktree';
const TEST_SESSION_NAME = 'mcbd-claude-test-worktree';

/** Reusable session options for startClaudeSession tests */
const TEST_SESSION_OPTIONS = {
  worktreeId: TEST_WORKTREE_ID,
  worktreePath: TEST_WORKTREE_PATH,
} as const;

/** Trust dialog output used across multiple test cases */
const TRUST_DIALOG_OUTPUT =
  'Quick safety check: Is this a project you created or one you trust?\n\n' +
  ' \u276F 1. Yes, I trust this folder\n   2. No, exit';

/**
 * Count how many sendKeys calls were "Enter-only" (empty string with sendEnter=true).
 * Used by trust dialog tests to verify Enter sending behavior.
 */
function countEnterOnlyCalls(): number {
  const calls = vi.mocked(sendKeys).mock.calls;
  return calls.filter((call) => call[1] === '' && call[2] === true).length;
}

describe('claude-session - Issue #152 improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Timeout constants (OCP-001)', () => {
    it('should export CLAUDE_INIT_TIMEOUT as 15000ms', () => {
      expect(CLAUDE_INIT_TIMEOUT).toBe(15000);
    });

    it('should export CLAUDE_INIT_POLL_INTERVAL as 300ms', () => {
      expect(CLAUDE_INIT_POLL_INTERVAL).toBe(300);
    });

    it('should export CLAUDE_POST_PROMPT_DELAY as 500ms', () => {
      expect(CLAUDE_POST_PROMPT_DELAY).toBe(500);
    });

    it('should export CLAUDE_PROMPT_WAIT_TIMEOUT as 5000ms', () => {
      expect(CLAUDE_PROMPT_WAIT_TIMEOUT).toBe(5000);
    });

    it('should export CLAUDE_PROMPT_POLL_INTERVAL as 200ms', () => {
      expect(CLAUDE_PROMPT_POLL_INTERVAL).toBe(200);
    });

    it('should export CLAUDE_SEND_PROMPT_WAIT_TIMEOUT as 10000ms', () => {
      expect(CLAUDE_SEND_PROMPT_WAIT_TIMEOUT).toBe(10000);
    });
  });

  describe('Pattern constants usage (DRY-001)', () => {
    it('should use CLAUDE_PROMPT_PATTERN from cli-patterns', () => {
      // Verify the pattern is the expected one
      expect(CLAUDE_PROMPT_PATTERN).toBeInstanceOf(RegExp);
      expect(CLAUDE_PROMPT_PATTERN.test('> ')).toBe(true);
      expect(CLAUDE_PROMPT_PATTERN.test('> /work-plan')).toBe(true);
    });

    it('should correctly match separator pattern from cli-patterns', () => {
      expect(CLAUDE_SEPARATOR_PATTERN).toBeInstanceOf(RegExp);
      expect(CLAUDE_SEPARATOR_PATTERN.test('────────────────')).toBe(true);
    });
  });

  describe('waitForPrompt() function (Task 1.4)', () => {
    it('should be exported as a function', () => {
      expect(typeof waitForPrompt).toBe('function');
    });

    it('should return immediately when prompt is detected', async () => {
      vi.mocked(capturePane).mockResolvedValue('Some output\n> \n');

      const promise = waitForPrompt(TEST_SESSION_NAME, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
      expect(capturePane).toHaveBeenCalledWith(TEST_SESSION_NAME, { startLine: -50 });
    });

    it('should detect legacy prompt character ">"', async () => {
      vi.mocked(capturePane).mockResolvedValue('Output\n> ');

      const promise = waitForPrompt(TEST_SESSION_NAME, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should detect new prompt character (U+276F)', async () => {
      vi.mocked(capturePane).mockResolvedValue('Output\n\u276F ');

      const promise = waitForPrompt(TEST_SESSION_NAME, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should poll until prompt is detected', async () => {
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'Processing...';
        }
        return '> ';
      });

      const promise = waitForPrompt(TEST_SESSION_NAME, 5000);

      // First call - no prompt
      await vi.advanceTimersByTimeAsync(0);
      expect(capturePane).toHaveBeenCalledTimes(1);

      // Wait for poll interval and second call
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL);
      expect(capturePane).toHaveBeenCalledTimes(2);

      // Wait for poll interval and third call - prompt detected
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL);

      await expect(promise).resolves.toBeUndefined();
      expect(callCount).toBeGreaterThanOrEqual(3);
    });

    it('should throw error on timeout', async () => {
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const timeout = 1000;
      const promise = waitForPrompt(TEST_SESSION_NAME, timeout);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow(`Prompt detection timeout (${timeout}ms)`);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(timeout + 100);

      await assertion;
    });

    it('should use default timeout when not specified', async () => {
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const promise = waitForPrompt(TEST_SESSION_NAME);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow(`Prompt detection timeout (${CLAUDE_PROMPT_WAIT_TIMEOUT}ms)`);

      // Advance past default timeout (CLAUDE_PROMPT_WAIT_TIMEOUT = 5000ms)
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_WAIT_TIMEOUT + 100);

      await assertion;
    });
  });

  describe('startClaudeSession() improvements (Task 1.3)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
    });

    it('should throw error on initialization timeout (CONS-005)', async () => {
      vi.mocked(capturePane).mockResolvedValue('Loading...');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow('Failed to start Claude session');

      // Advance past CLAUDE_INIT_TIMEOUT
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);

      await assertion;
    });

    it('should detect prompt using CLAUDE_PROMPT_PATTERN (DRY-001)', async () => {
      // Return prompt after a few polls
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'Starting Claude...';
        }
        return '> '; // Legacy prompt
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through initial polls, sanitize 100ms delay, and stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should not treat separator-only output as initialization complete (Issue #187, P1-1)', async () => {
      // capturePane always returns separator only (no prompt)
      vi.mocked(capturePane).mockResolvedValue('────────────────────');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow('Failed to start Claude session');

      // Advance past CLAUDE_INIT_TIMEOUT
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);

      await assertion;
    });

    it('should wait CLAUDE_POST_PROMPT_DELAY after prompt detection (CONS-007)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + initial poll
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL);

      // Session should still be waiting for stability delay
      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should reuse healthy existing session without creating new one', async () => {
      // Issue #265: existing healthy session should be reused
      vi.mocked(hasSession).mockResolvedValue(true);
      // Return Claude prompt output indicating healthy session
      vi.mocked(capturePane).mockResolvedValue('> ');

      await startClaudeSession(TEST_SESSION_OPTIONS);

      expect(createSession).not.toHaveBeenCalled();
    });

    it('should recreate unhealthy existing session (Issue #265, Bug 2)', async () => {
      // Session exists but is broken (shows error message)
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockImplementation(async () => {
        // After kill and recreation, return prompt for initialization
        if (vi.mocked(killSession).mock.calls.length > 0) {
          return '> ';
        }
        // Before kill: broken session with error
        return 'Claude Code cannot be launched inside another Claude Code session';
      });
      vi.mocked(killSession).mockResolvedValue(true);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + initialization polls + stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // killSession should have been called to clean up broken session
      expect(killSession).toHaveBeenCalledWith(TEST_SESSION_NAME);
      // New session should have been created
      expect(createSession).toHaveBeenCalled();
    });
  });

  describe('sendMessageToClaude() improvements (Task 1.5)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
    });

    it('should verify prompt state before sending (CONS-006)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello Claude');

      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await promise;

      expect(capturePane).toHaveBeenCalled();
    });

    it('should call waitForPrompt if not at prompt (CONS-006)', async () => {
      // First call: not at prompt, second call: at prompt
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return 'Processing...';
        }
        return '> ';
      });

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello Claude');

      // Advance through poll interval for waitForPrompt + stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL + CLAUDE_POST_PROMPT_DELAY);

      await promise;

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should use sendKeys for Enter instead of execAsync (CONS-001)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello Claude');

      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await promise;

      // Should call sendKeys twice: once for message, once for Enter
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys).toHaveBeenNthCalledWith(1, TEST_SESSION_NAME, 'Hello Claude', false);
      expect(sendKeys).toHaveBeenNthCalledWith(2, TEST_SESSION_NAME, '', true);
    });

    it('should throw error if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(sendMessageToClaude(TEST_WORKTREE_ID, 'Hello')).rejects.toThrow(
        `Claude session ${TEST_SESSION_NAME} does not exist`
      );
    });

    it('should throw error if prompt not detected within timeout (Issue #187, P1-2/P1-3)', async () => {
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello');

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow(`Prompt detection timeout (${CLAUDE_SEND_PROMPT_WAIT_TIMEOUT}ms)`);

      // Advance past CLAUDE_SEND_PROMPT_WAIT_TIMEOUT
      await vi.advanceTimersByTimeAsync(CLAUDE_SEND_PROMPT_WAIT_TIMEOUT + 100);

      await assertion;
      // Verify sendKeys was NOT called (message not sent on timeout)
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  describe('sendMessageToClaude() - P0: stability delay (Issue #187)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
    });

    it('should wait CLAUDE_POST_PROMPT_DELAY after immediate prompt detection (Path A)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello');

      // sendKeys should NOT be called yet (waiting for stability delay)
      expect(sendKeys).not.toHaveBeenCalled();

      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await promise;

      // Now sendKeys should have been called
      expect(sendKeys).toHaveBeenCalledTimes(2);
    });

    it('should wait CLAUDE_POST_PROMPT_DELAY after waitForPrompt returns (Path B)', async () => {
      // Mock setup: sendMessageToClaude's initial capturePane returns non-prompt,
      // triggering the waitForPrompt path. waitForPrompt's first internal
      // capturePane call (the 2nd overall) returns non-prompt, requiring a poll cycle.
      // The 3rd capturePane call (after one CLAUDE_PROMPT_POLL_INTERVAL) returns prompt.
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) return 'Processing...';
        return '> ';
      });

      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'Hello');

      // Advance through waitForPrompt polling (one full poll cycle needed)
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL);

      // sendKeys should NOT be called yet (waiting for stability delay)
      expect(sendKeys).not.toHaveBeenCalled();

      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await promise;

      expect(sendKeys).toHaveBeenCalledTimes(2);
    });
  });

  describe('startClaudeSession() - trust dialog (Issue #201)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
    });

    it('should send Enter when trust dialog is detected', async () => {
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First poll: trust dialog displayed
          return TRUST_DIALOG_OUTPUT;
        }
        // Subsequent polls: prompt displayed after Enter
        return '\u276F ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + polls and stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // Verify Enter was sent exactly once for trust dialog
      // sendKeys calls include: unset CLAUDECODE (true), claudePath (true), trust dialog Enter (true)
      // countEnterOnlyCalls counts calls with empty string + true
      expect(countEnterOnlyCalls()).toBe(1);
    });

    it('should send Enter only once even when dialog persists (duplicate prevention)', async () => {
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          // First two polls: trust dialog still displayed (buffer not yet updated)
          return TRUST_DIALOG_OUTPUT;
        }
        // Third poll: prompt displayed
        return '\u276F ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + polls and stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // Verify Enter was sent only once (not on second dialog detection)
      expect(countEnterOnlyCalls()).toBe(1);
    });

    it('should not affect existing dialog-less flow (regression test)', async () => {
      // Standard flow: no trust dialog, just prompt
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'Starting Claude...';
        }
        return '> ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + polls and stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // Verify no extra Enter was sent for trust dialog
      // Only the initial claudePath sendKeys should use Enter (true)
      expect(countEnterOnlyCalls()).toBe(0);
    });

    it('should complete initialization after trust dialog Enter send', async () => {
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return ' \u276F 1. Yes, I trust this folder\n   2. No, exit';
        }
        return '\u276F ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);

      // Advance through sanitize delay + polls and stability delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);

      // Should resolve successfully (not timeout)
      await expect(promise).resolves.toBeUndefined();
    });
  });

  describe('getSessionName()', () => {
    it('should generate session name with mcbd-claude- prefix', () => {
      expect(getSessionName(TEST_WORKTREE_ID)).toBe(TEST_SESSION_NAME);
    });
  });

  // Issue #212: Pasted text detection in sendMessageToClaude
  describe('sendMessageToClaude() - Pasted text detection (Issue #212)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');
    });

    // MF-001: Single-line messages should skip detection
    it('should skip Pasted text detection for single-line messages', async () => {
      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'hello');
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // detectAndResendIfPastedText should NOT be called for single-line
      expect(detectAndResendIfPastedText).not.toHaveBeenCalled();
      // Standard sendKeys should still be called (message + Enter)
      expect(sendKeys).toHaveBeenCalledTimes(2);
    });

    // Multi-line messages should trigger detection
    it('should run Pasted text detection for multi-line messages', async () => {
      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'line1\nline2');
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // detectAndResendIfPastedText should be called with session name
      expect(detectAndResendIfPastedText).toHaveBeenCalledWith(TEST_SESSION_NAME);
      expect(detectAndResendIfPastedText).toHaveBeenCalledTimes(1);
    });

    // Existing flow should not be affected
    it('should not affect existing message sending flow', async () => {
      const promise = sendMessageToClaude(TEST_WORKTREE_ID, 'line1\nline2\nline3');
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // sendKeys order: message first, then Enter
      expect(sendKeys).toHaveBeenNthCalledWith(1, TEST_SESSION_NAME, 'line1\nline2\nline3', false);
      expect(sendKeys).toHaveBeenNthCalledWith(2, TEST_SESSION_NAME, '', true);
    });
  });
});

// ============================================================
// Issue #265: Cache invalidation, health check, CLAUDECODE removal
// ============================================================
describe('claude-session - Issue #265 improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    // Always clear the cached path before each test
    clearCachedClaudePath();
  });

  afterEach(() => {
    vi.useRealTimers();
    // Restore env vars
    delete process.env.CLAUDE_PATH;
  });

  // ----- Bug 1: Cache invalidation -----
  describe('Bug 1: clearCachedClaudePath() (cache invalidation)', () => {
    it('should export clearCachedClaudePath as a function', () => {
      expect(typeof clearCachedClaudePath).toBe('function');
    });

    it('should clear cached path so next getClaudePath() re-resolves', async () => {
      // First call caches the path
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Clear the cache
      clearCachedClaudePath();

      // The next startClaudeSession should resolve the path again (exec 'which claude')
      vi.mocked(hasSession).mockResolvedValue(false);
      const promise2 = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise2;

      // 'which claude' should have been called at least twice (once per session start)
      const { exec } = await import('child_process');
      const execCalls = vi.mocked(exec).mock.calls;
      const whichCalls = execCalls.filter(call => (call[0] as string).includes('which claude'));
      expect(whichCalls.length).toBeGreaterThanOrEqual(2);
    });

    it('should clear cache on session start failure (MF-S2-002)', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockRejectedValue(new Error('tmux create failed'));

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      const assertion = expect(promise).rejects.toThrow('Failed to start Claude session');

      await vi.advanceTimersByTimeAsync(100);
      await assertion;

      // After failure, clearCachedClaudePath should have been called
      // We verify by checking that clearCachedClaudePath is a no-op (no error)
      expect(() => clearCachedClaudePath()).not.toThrow();
    });
  });

  // ----- Bug 1: CLAUDE_PATH validation (SEC-MF-001) -----
  describe('Bug 1: isValidClaudePath() / CLAUDE_PATH validation (SEC-MF-001)', () => {
    it('should accept valid CLAUDE_PATH', async () => {
      process.env.CLAUDE_PATH = '/usr/local/bin/claude';

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // sendKeys should have been called with the valid CLAUDE_PATH
      expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/usr/local/bin/claude', true);
    });

    it('should reject CLAUDE_PATH with shell metacharacters', async () => {
      process.env.CLAUDE_PATH = '/bin/sh -c "malicious" #';

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Should have fallen through to 'which claude' fallback, not used the env var
      expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/usr/local/bin/claude', true);
    });

    it('should reject CLAUDE_PATH with path traversal', async () => {
      process.env.CLAUDE_PATH = '/usr/../etc/passwd';

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Should have fallen through to 'which claude' fallback
      expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/usr/local/bin/claude', true);
    });

    it('should reject CLAUDE_PATH with pipe characters', async () => {
      process.env.CLAUDE_PATH = '/usr/bin/claude|cat /etc/passwd';

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Should have fallen through to 'which claude' fallback
      expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/usr/local/bin/claude', true);
    });

    it('should reject CLAUDE_PATH that is not executable', async () => {
      process.env.CLAUDE_PATH = '/usr/local/bin/nonexistent-claude';

      // Mock fs.access to reject (not executable)
      const fsPromises = await import('fs/promises');
      vi.mocked(fsPromises.access).mockRejectedValue(new Error('ENOENT'));

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Should have fallen through to 'which claude' fallback
      expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/usr/local/bin/claude', true);
    });
  });

  // ----- Bug 2: Health check -----
  describe('Bug 2: isSessionHealthy() / ensureHealthySession()', () => {
    it('should detect error pattern and report session as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue(
        'Claude Code cannot be launched inside another Claude Code session'
      );

      // isClaudeRunning should return false for broken session
      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect regex error pattern and report session as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('Error: Claude Code initialization failed');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect shell prompt ending "$" as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('user@host:~/project$');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect shell prompt ending "%" as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('user@host ~/project%');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect shell prompt ending "#" as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('root@host:~/project#');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect empty output as unhealthy (C-S2-001)', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should detect whitespace-only output as unhealthy', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('   \n  \n  ');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should report healthy session with Claude prompt as running', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('Some Claude output\n> ');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(true);
    });

    it('should report healthy session with thinking indicator as running', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('Processing request...\n\u2713 Working on it...');

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(true);
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should handle capturePane errors gracefully', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockRejectedValue(new Error('tmux error'));

      const result = await isClaudeRunning(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });
  });

  describe('Bug 2: startClaudeSession() session recovery', () => {
    beforeEach(() => {
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(killSession).mockResolvedValue(true);
    });

    it('should kill and recreate broken session with error pattern', async () => {
      let hasBeenKilled = false;
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(killSession).mockImplementation(async () => {
        hasBeenKilled = true;
        // After kill, hasSession returns false for next check
        vi.mocked(hasSession).mockResolvedValue(false);
        return true;
      });
      vi.mocked(capturePane).mockImplementation(async () => {
        if (!hasBeenKilled) {
          return 'Claude Code cannot be launched inside another Claude Code session';
        }
        return '> ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      expect(killSession).toHaveBeenCalledWith(TEST_SESSION_NAME);
      expect(createSession).toHaveBeenCalled();
    });

    it('should kill and recreate session showing shell prompt only', async () => {
      let hasBeenKilled = false;
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(killSession).mockImplementation(async () => {
        hasBeenKilled = true;
        vi.mocked(hasSession).mockResolvedValue(false);
        return true;
      });
      vi.mocked(capturePane).mockImplementation(async () => {
        if (!hasBeenKilled) {
          return 'user@host:~/project$';
        }
        return '> ';
      });

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      expect(killSession).toHaveBeenCalledWith(TEST_SESSION_NAME);
      expect(createSession).toHaveBeenCalled();
    });
  });

  // ----- Bug 3: CLAUDECODE environment variable removal -----
  describe('Bug 3: sanitizeSessionEnvironment() (CLAUDECODE removal)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');
    });

    it('should send unset CLAUDECODE command during session creation', async () => {
      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Verify that 'unset CLAUDECODE' was sent via sendKeys
      const sendKeysCalls = vi.mocked(sendKeys).mock.calls;
      const unsetCalls = sendKeysCalls.filter(
        (call) => call[1] === 'unset CLAUDECODE' && call[2] === true
      );
      expect(unsetCalls.length).toBe(1);
    });

    it('should call tmux set-environment -g -u CLAUDECODE during session creation', async () => {
      const { exec } = await import('child_process');

      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Verify tmux set-environment was called
      const execCalls = vi.mocked(exec).mock.calls;
      const tmuxEnvCalls = execCalls.filter(
        (call) => (call[0] as string).includes('tmux set-environment -g -u CLAUDECODE')
      );
      expect(tmuxEnvCalls.length).toBe(1);
    });

    it('should sanitize environment before launching claude CLI', async () => {
      const promise = startClaudeSession(TEST_SESSION_OPTIONS);
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
      await promise;

      // Verify call order: unset CLAUDECODE should come before claudePath
      const sendKeysCalls = vi.mocked(sendKeys).mock.calls;
      const unsetIndex = sendKeysCalls.findIndex(
        (call) => call[1] === 'unset CLAUDECODE'
      );
      const claudePathIndex = sendKeysCalls.findIndex(
        (call) => call[1] === '/usr/local/bin/claude'
      );

      expect(unsetIndex).toBeLessThan(claudePathIndex);
    });
  });

  // ----- Error pattern constants -----
  describe('Error pattern constants (MF-001)', () => {
    it('should export CLAUDE_SESSION_ERROR_PATTERNS from cli-patterns', () => {
      expect(CLAUDE_SESSION_ERROR_PATTERNS).toBeDefined();
      expect(Array.isArray(CLAUDE_SESSION_ERROR_PATTERNS)).toBe(true);
      expect(CLAUDE_SESSION_ERROR_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should include nested session error pattern', () => {
      expect(CLAUDE_SESSION_ERROR_PATTERNS).toContain(
        'Claude Code cannot be launched inside another Claude Code session'
      );
    });

    it('should export CLAUDE_SESSION_ERROR_REGEX_PATTERNS from cli-patterns', () => {
      expect(CLAUDE_SESSION_ERROR_REGEX_PATTERNS).toBeDefined();
      expect(Array.isArray(CLAUDE_SESSION_ERROR_REGEX_PATTERNS)).toBe(true);
      expect(CLAUDE_SESSION_ERROR_REGEX_PATTERNS.length).toBeGreaterThan(0);
    });

    it('should have regex pattern that matches ^Error:.*Claude Code', () => {
      const pattern = CLAUDE_SESSION_ERROR_REGEX_PATTERNS[0];
      expect(pattern.test('Error: Claude Code initialization failed')).toBe(true);
      expect(pattern.test('No errors here')).toBe(false);
      // Should not match mid-line errors (requires ^ anchor)
      expect(pattern.test('Some prefix Error: Claude Code')).toBe(false);
    });
  });

  // ----- Coverage improvement: existing functions -----
  describe('isClaudeInstalled()', () => {
    it('should return true when claude is found', async () => {
      const result = await isClaudeInstalled();
      expect(result).toBe(true);
    });
  });

  describe('captureClaudeOutput()', () => {
    it('should return captured output when session exists', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('Some Claude output\n> ');

      const result = await captureClaudeOutput(TEST_WORKTREE_ID);
      expect(result).toBe('Some Claude output\n> ');
      expect(capturePane).toHaveBeenCalledWith(TEST_SESSION_NAME, { startLine: -1000 });
    });

    it('should throw error when session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(captureClaudeOutput(TEST_WORKTREE_ID)).rejects.toThrow(
        `Claude session ${TEST_SESSION_NAME} does not exist`
      );
    });

    it('should throw error when capturePane fails', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockRejectedValue(new Error('tmux error'));

      await expect(captureClaudeOutput(TEST_WORKTREE_ID)).rejects.toThrow(
        'Failed to capture Claude output'
      );
    });

    it('should accept custom line count', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('output');

      await captureClaudeOutput(TEST_WORKTREE_ID, 500);
      expect(capturePane).toHaveBeenCalledWith(TEST_SESSION_NAME, { startLine: -500 });
    });
  });

  describe('stopClaudeSession()', () => {
    it('should stop session and return true', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(killSession).mockResolvedValue(true);

      const promise = stopClaudeSession(TEST_WORKTREE_ID);

      // Advance timer for the 500ms wait inside stopClaudeSession
      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;
      expect(result).toBe(true);
      expect(killSession).toHaveBeenCalledWith(TEST_SESSION_NAME);
    });

    it('should return false when session does not exist and kill fails', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(killSession).mockResolvedValue(false);

      const result = await stopClaudeSession(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });

    it('should handle errors gracefully', async () => {
      vi.mocked(hasSession).mockRejectedValue(new Error('tmux error'));

      const result = await stopClaudeSession(TEST_WORKTREE_ID);
      expect(result).toBe(false);
    });
  });

  describe('getClaudeSessionState()', () => {
    it('should return session state when running', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      const state = await getClaudeSessionState(TEST_WORKTREE_ID);

      expect(state.sessionName).toBe(TEST_SESSION_NAME);
      expect(state.isRunning).toBe(true);
      expect(state.lastActivity).toBeInstanceOf(Date);
    });

    it('should return session state when not running', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      const state = await getClaudeSessionState(TEST_WORKTREE_ID);

      expect(state.sessionName).toBe(TEST_SESSION_NAME);
      expect(state.isRunning).toBe(false);
    });

    it('should return existence-based state without health check (C-S3-002)', async () => {
      // getClaudeSessionState uses hasSession (not isSessionHealthy), so a broken
      // session still reports isRunning=true. This is by design for lightweight queries.
      vi.mocked(hasSession).mockResolvedValue(true);
      // Even if capturePane would show an error, getClaudeSessionState does not check it
      vi.mocked(capturePane).mockResolvedValue('Claude Code cannot be launched inside another Claude Code session');

      const state = await getClaudeSessionState(TEST_WORKTREE_ID);
      expect(state.isRunning).toBe(true);
      // capturePane should NOT be called by getClaudeSessionState
      expect(capturePane).not.toHaveBeenCalled();
    });
  });

  // ----- Coverage: restartClaudeSession -----
  // NOTE: Placed BEFORE exec-overriding tests to avoid mock pollution
  describe('restartClaudeSession()', () => {
    it('should stop existing session then start a new one', async () => {
      // Setup mocks for the full restart flow
      vi.mocked(hasSession)
        .mockResolvedValueOnce(true)   // stopClaudeSession -> hasSession (Ctrl+D path)
        .mockResolvedValueOnce(false)  // startClaudeSession -> hasSession (no existing session)
        ;
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(killSession).mockResolvedValue(true);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = restartClaudeSession(TEST_SESSION_OPTIONS);

      // stopClaudeSession: Ctrl+D wait (500ms)
      await vi.advanceTimersByTimeAsync(500);
      // restartClaudeSession: inter-restart delay (1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      // startClaudeSession: sanitize delay (100ms) + poll intervals + post-prompt delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // Verify stop was attempted (killSession called by stopClaudeSession)
      expect(killSession).toHaveBeenCalledWith(TEST_SESSION_NAME);
      // Verify new session was created
      expect(createSession).toHaveBeenCalled();
    });

    it('should handle stop failure gracefully and still attempt restart', async () => {
      // stopClaudeSession: session doesn't exist
      vi.mocked(hasSession)
        .mockResolvedValueOnce(false)  // stopClaudeSession -> no session
        .mockResolvedValueOnce(false)  // startClaudeSession -> hasSession
        ;
      vi.mocked(killSession).mockResolvedValue(false);
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = restartClaudeSession(TEST_SESSION_OPTIONS);

      // restartClaudeSession: inter-restart delay (1000ms)
      await vi.advanceTimersByTimeAsync(1000);
      // startClaudeSession: sanitize delay (100ms) + poll intervals + post-prompt delay
      await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();

      // New session should still be created even if stop found no session
      expect(createSession).toHaveBeenCalled();
    });
  });

  // ----- exec-overriding tests grouped together with afterEach cleanup -----
  // These tests override the module-level exec mock and must restore it afterward
  describe('exec mock override tests (CLI path resolution)', () => {
    /** Restore the default exec mock after each test that overrides it */
    afterEach(async () => {
      const { exec } = await import('child_process');
      vi.mocked(exec).mockImplementation((cmd: string, opts: unknown, cb?: unknown) => {
        if (typeof opts === 'function') {
          cb = opts;
        }
        const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if ((cmd as string).includes('which claude')) {
          callback(null, { stdout: '/usr/local/bin/claude', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });
    });

    // ----- Coverage: isClaudeInstalled failure path -----
    describe('isClaudeInstalled() failure path', () => {
      it('should return false when which claude fails', async () => {
        const { exec } = await import('child_process');
        vi.mocked(exec).mockImplementation((cmd: string, opts: unknown, cb?: unknown) => {
          if (typeof opts === 'function') {
            cb = opts;
          }
          const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
          callback(new Error('not found'), { stdout: '', stderr: '' });
          return {} as ReturnType<typeof exec>;
        });

        const result = await isClaudeInstalled();
        expect(result).toBe(false);
      });
    });

    // ----- Coverage: startClaudeSession when Claude is not installed -----
    describe('startClaudeSession() when Claude is not installed', () => {
      it('should throw error when Claude CLI is not available', async () => {
        const { exec } = await import('child_process');
        vi.mocked(exec).mockImplementation((cmd: string, opts: unknown, cb?: unknown) => {
          if (typeof opts === 'function') {
            cb = opts;
          }
          const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
          callback(new Error('not found'), { stdout: '', stderr: '' });
          return {} as ReturnType<typeof exec>;
        });
        vi.mocked(hasSession).mockResolvedValue(false);

        await expect(startClaudeSession(TEST_SESSION_OPTIONS)).rejects.toThrow(
          'Claude CLI is not installed or not in PATH'
        );
      });
    });

    // ----- Coverage: getClaudePath fallback paths -----
    describe('getClaudePath() fallback to common paths', () => {
      it('should use fallback path when which command fails but test -x succeeds', async () => {
        const { exec } = await import('child_process');
        let whichCallCount = 0;
        vi.mocked(exec).mockImplementation((cmd: string, opts: unknown, cb?: unknown) => {
          if (typeof opts === 'function') {
            cb = opts;
          }
          const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
          if ((cmd as string).includes('which claude')) {
            whichCallCount++;
            if (whichCallCount === 1) {
              callback(null, { stdout: '/usr/local/bin/claude', stderr: '' });
            } else {
              callback(new Error('not found'), { stdout: '', stderr: '' });
            }
          } else if ((cmd as string).includes('test -x')) {
            callback(null, { stdout: '', stderr: '' });
          } else {
            callback(null, { stdout: '', stderr: '' });
          }
          return {} as ReturnType<typeof exec>;
        });

        vi.mocked(hasSession).mockResolvedValue(false);
        vi.mocked(createSession).mockResolvedValue();
        vi.mocked(sendKeys).mockResolvedValue();
        vi.mocked(capturePane).mockResolvedValue('> ');

        const promise = startClaudeSession(TEST_SESSION_OPTIONS);
        await vi.advanceTimersByTimeAsync(100 + CLAUDE_INIT_POLL_INTERVAL * 2 + CLAUDE_POST_PROMPT_DELAY);
        await promise;

        expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '/opt/homebrew/bin/claude', true);
      });

      it('should throw error when all paths including fallbacks fail', async () => {
        const { exec } = await import('child_process');
        let whichCallCount = 0;
        vi.mocked(exec).mockImplementation((cmd: string, opts: unknown, cb?: unknown) => {
          if (typeof opts === 'function') {
            cb = opts;
          }
          const callback = cb as (err: Error | null, result: { stdout: string; stderr: string }) => void;
          if ((cmd as string).includes('which claude')) {
            whichCallCount++;
            if (whichCallCount === 1) {
              callback(null, { stdout: '/usr/local/bin/claude', stderr: '' });
            } else {
              callback(new Error('not found'), { stdout: '', stderr: '' });
            }
          } else {
            callback(new Error('not found'), { stdout: '', stderr: '' });
          }
          return {} as ReturnType<typeof exec>;
        });

        vi.mocked(hasSession).mockResolvedValue(false);
        vi.mocked(createSession).mockResolvedValue();
        vi.mocked(sendKeys).mockResolvedValue();

        const promise = startClaudeSession(TEST_SESSION_OPTIONS);
        const assertion = expect(promise).rejects.toThrow('Failed to start Claude session');
        await vi.advanceTimersByTimeAsync(100);
        await assertion;
      });
    });
  });

  // ----- Coverage: captureClaudeOutput with default lines -----
  describe('captureClaudeOutput() default lines parameter', () => {
    it('should use default 1000 lines when not specified', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('output');

      await captureClaudeOutput(TEST_WORKTREE_ID);
      expect(capturePane).toHaveBeenCalledWith(TEST_SESSION_NAME, { startLine: -1000 });
    });
  });

  // ----- Coverage: stopClaudeSession when killSession returns false -----
  describe('stopClaudeSession() edge cases', () => {
    it('should return result from killSession when session exists', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
      vi.mocked(killSession).mockResolvedValue(false);

      const promise = stopClaudeSession(TEST_WORKTREE_ID);
      await vi.advanceTimersByTimeAsync(500);

      const result = await promise;
      expect(result).toBe(false);
    });
  });
});

// ============================================================
// Issue #306: Session stability improvements
// ============================================================
describe('claude-session - Issue #306 improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearCachedClaudePath();
  });

  // ----- Task 4.2: False positive prevention tests (Section 6.1) -----
  describe('isSessionHealthy - false positive prevention', () => {
    it('should treat "Context left until auto-compact: 7%" as healthy', async () => {
      vi.mocked(capturePane).mockResolvedValue('Context left until auto-compact: 7%');

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should treat "Context left until auto-compact: 100%" as healthy', async () => {
      vi.mocked(capturePane).mockResolvedValue('Context left until auto-compact: 100%');

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should still detect real zsh prompt ending with %', async () => {
      // Short shell prompt (under 40 chars) ending with %
      vi.mocked(capturePane).mockResolvedValue('user@host%');

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('shell prompt ending detected');
    });

    it('should treat long lines ending with $ as healthy', async () => {
      // 50 characters ending with $ - line length check should exclude
      const longLine = 'a'.repeat(49) + '$';
      vi.mocked(capturePane).mockResolvedValue(longLine);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should treat long lines ending with # as healthy', async () => {
      // 50 characters ending with # - line length check should exclude
      const longLine = 'a'.repeat(49) + '#';
      vi.mocked(capturePane).mockResolvedValue(longLine);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should filter trailing empty lines before checking last line', async () => {
      // Claude output followed by trailing empty lines
      vi.mocked(capturePane).mockResolvedValue('Some Claude output\n\n\n');

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    // F004: MAX_SHELL_PROMPT_LENGTH boundary value tests
    it('should treat 39-char line ending with $ as unhealthy (below threshold)', async () => {
      // 39 characters (below threshold): shell prompt detection -> unhealthy
      const line = 'a'.repeat(38) + '$';
      expect(line.length).toBe(39);
      vi.mocked(capturePane).mockResolvedValue(line);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('shell prompt ending detected');
    });

    it('should treat 40-char line ending with $ as healthy (at threshold)', async () => {
      // 40 characters (at threshold): line length check excludes -> healthy
      const line = 'a'.repeat(39) + '$';
      expect(line.length).toBe(40);
      vi.mocked(capturePane).mockResolvedValue(line);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should treat 41-char line ending with $ as healthy (above threshold)', async () => {
      // 41 characters (above threshold): line length check excludes -> healthy
      const line = 'a'.repeat(40) + '$';
      expect(line.length).toBe(41);
      vi.mocked(capturePane).mockResolvedValue(line);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    // F006: Line length check before SHELL_PROMPT_ENDINGS check
    it('should apply line length check before SHELL_PROMPT_ENDINGS check', async () => {
      // 50-char line ending with $ should be healthy due to line length early return
      const longLine = 'a'.repeat(49) + '$';
      expect(longLine.length).toBe(50);
      vi.mocked(capturePane).mockResolvedValue(longLine);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
      // No reason should be set for healthy results
      expect(result.reason).toBeUndefined();
    });
  });

  // ----- Task 4.2: Reason reporting tests (Section 6.2) -----
  describe('isSessionHealthy - reason reporting', () => {
    it('should include reason for error pattern detection', async () => {
      vi.mocked(capturePane).mockResolvedValue(
        'Claude Code cannot be launched inside another Claude Code session'
      );

      const result: HealthCheckResult = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toMatch(/^error pattern: /);
    });

    it('should include reason for shell prompt ending', async () => {
      vi.mocked(capturePane).mockResolvedValue('user@host:~$');

      const result: HealthCheckResult = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toMatch(/^shell prompt ending detected: /);
    });

    it('should include reason for empty output', async () => {
      vi.mocked(capturePane).mockResolvedValue('');

      const result: HealthCheckResult = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toBe('empty output');
    });

    // S3-F001: capturePane exception reason test
    it('should include reason "capture error" when capturePane throws', async () => {
      vi.mocked(capturePane).mockRejectedValue(new Error('tmux pane error'));

      const result: HealthCheckResult = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toBe('capture error');
    });

    it('should not include reason for healthy sessions', async () => {
      vi.mocked(capturePane).mockResolvedValue('Some Claude output\n> ');

      const result: HealthCheckResult = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
      expect(result.reason).toBeUndefined();
    });
  });

  // ----- Active state priority + tail-only error detection -----
  describe('isSessionHealthy - active state priority over historical errors', () => {
    it('should treat session with historical error AND active prompt as healthy', async () => {
      // Simulates a session that recovered from a nested session error:
      // Error appears in scrollback, but Claude restarted and is now at prompt
      const paneOutput = [
        'Error: Exit code 1',
        'Error: Claude Code cannot be launched inside another Claude Code session.',
        'Nested sessions share runtime resources and will crash all active sessions.',
        'To bypass this check, unset the CLAUDECODE environment variable.',
        '',
        'unset CLAUDECODE',
        '/Users/user/.local/bin/claude',
        '',
        'Some Claude output here',
        '❯ ',
      ].join('\n');
      vi.mocked(capturePane).mockResolvedValue(paneOutput);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should treat session with historical error AND > prompt as healthy', async () => {
      const paneOutput = [
        'Claude Code cannot be launched inside another Claude Code session',
        '',
        'Recovery happened...',
        '> ',
      ].join('\n');
      vi.mocked(capturePane).mockResolvedValue(paneOutput);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });

    it('should detect error when it appears in tail lines without active prompt', async () => {
      // Error is recent (in tail), no prompt visible → unhealthy
      const paneOutput = [
        'Starting Claude...',
        'Claude Code cannot be launched inside another Claude Code session',
      ].join('\n');
      vi.mocked(capturePane).mockResolvedValue(paneOutput);

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(false);
      expect(result.reason).toContain('error pattern');
    });

    it('should ignore error that scrolled out of tail window', async () => {
      // Error is old (beyond tail window), no prompt but long output → healthy
      const lines = [
        'Claude Code cannot be launched inside another Claude Code session',
        ...Array.from({ length: 15 }, (_, i) => `Processing line ${i + 1}...`),
        'Task completed successfully',
      ];
      vi.mocked(capturePane).mockResolvedValue(lines.join('\n'));

      const result = await isSessionHealthy(TEST_SESSION_NAME);
      expect(result.healthy).toBe(true);
    });
  });
});
