/**
 * Tests for claude-session module improvements
 * Issue #152: Fix first message not being sent after session start
 * Issue #187: Fix session first message reliability
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

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn((cmd, opts, cb) => {
    if (typeof opts === 'function') {
      cb = opts;
    }
    if (cmd.includes('which claude')) {
      cb(null, { stdout: '/usr/local/bin/claude', stderr: '' });
    } else {
      cb(null, { stdout: '', stderr: '' });
    }
    return {};
  }),
}));

import {
  startClaudeSession,
  sendMessageToClaude,
  waitForPrompt,
  getSessionName,
  CLAUDE_INIT_TIMEOUT,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
  CLAUDE_PROMPT_WAIT_TIMEOUT,
  CLAUDE_PROMPT_POLL_INTERVAL,
  CLAUDE_SEND_PROMPT_WAIT_TIMEOUT,
} from '@/lib/claude-session';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux';
import { CLAUDE_PROMPT_PATTERN, CLAUDE_SEPARATOR_PATTERN } from '@/lib/cli-patterns';

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
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Some output\n> \n');

      const promise = waitForPrompt(sessionName, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
      expect(capturePane).toHaveBeenCalledWith(sessionName, { startLine: -50 });
    });

    it('should detect legacy prompt character ">"', async () => {
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Output\n> ');

      const promise = waitForPrompt(sessionName, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should detect new prompt character (U+276F)', async () => {
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Output\n\u276F ');

      const promise = waitForPrompt(sessionName, 1000);
      await vi.advanceTimersByTimeAsync(0);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should poll until prompt is detected', async () => {
      const sessionName = 'mcbd-claude-test-worktree';
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'Processing...';
        }
        return '> ';
      });

      const promise = waitForPrompt(sessionName, 5000);

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
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const timeout = 1000;
      const promise = waitForPrompt(sessionName, timeout);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow(`Prompt detection timeout (${timeout}ms)`);

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(timeout + 100);

      await assertion;
    });

    it('should use default timeout when not specified', async () => {
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const promise = waitForPrompt(sessionName);

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

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      const promise = startClaudeSession(options);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow('Claude initialization timeout');

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

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      const promise = startClaudeSession(options);

      // Advance through initial polls and stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should not treat separator-only output as initialization complete (Issue #187, P1-1)', async () => {
      // capturePane always returns separator only (no prompt)
      vi.mocked(capturePane).mockResolvedValue('────────────────────');

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      const promise = startClaudeSession(options);

      // Attach rejection handler before advancing timers to prevent unhandled rejection
      const assertion = expect(promise).rejects.toThrow('Claude initialization timeout');

      // Advance past CLAUDE_INIT_TIMEOUT
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);

      await assertion;
    });

    it('should wait CLAUDE_POST_PROMPT_DELAY after prompt detection (CONS-007)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      const promise = startClaudeSession(options);

      // Advance through initial poll
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL);

      // Session should still be waiting for stability delay
      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();
    });

    it('should skip initialization if session already exists', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      await startClaudeSession(options);

      expect(createSession).not.toHaveBeenCalled();
      expect(sendKeys).not.toHaveBeenCalled();
    });
  });

  describe('sendMessageToClaude() improvements (Task 1.5)', () => {
    beforeEach(() => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue();
    });

    it('should verify prompt state before sending (CONS-006)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = sendMessageToClaude('test-worktree', 'Hello Claude');

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

      const promise = sendMessageToClaude('test-worktree', 'Hello Claude');

      // Advance through poll interval for waitForPrompt + stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL + CLAUDE_POST_PROMPT_DELAY);

      await promise;

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should use sendKeys for Enter instead of execAsync (CONS-001)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = sendMessageToClaude('test-worktree', 'Hello Claude');

      // Advance through stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_POST_PROMPT_DELAY);

      await promise;

      // Should call sendKeys twice: once for message, once for Enter
      expect(sendKeys).toHaveBeenCalledTimes(2);
      expect(sendKeys).toHaveBeenNthCalledWith(1, 'mcbd-claude-test-worktree', 'Hello Claude', false);
      expect(sendKeys).toHaveBeenNthCalledWith(2, 'mcbd-claude-test-worktree', '', true);
    });

    it('should throw error if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(sendMessageToClaude('test-worktree', 'Hello')).rejects.toThrow(
        'Claude session mcbd-claude-test-worktree does not exist'
      );
    });

    it('should throw error if prompt not detected within timeout (Issue #187, P1-2/P1-3)', async () => {
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const promise = sendMessageToClaude('test-worktree', 'Hello');

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

      const promise = sendMessageToClaude('test-worktree', 'Hello');

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

      const promise = sendMessageToClaude('test-worktree', 'Hello');

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

  describe('getSessionName()', () => {
    it('should generate session name with mcbd-claude- prefix', () => {
      expect(getSessionName('test-worktree')).toBe('mcbd-claude-test-worktree');
    });
  });
});
