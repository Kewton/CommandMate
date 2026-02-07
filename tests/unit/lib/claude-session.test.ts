/**
 * Tests for claude-session module improvements
 * Issue #152: Fix first message not being sent after session start
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
  sendMessageWithEnter: vi.fn(),
  sendSpecialKey: vi.fn(),
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
} from '@/lib/claude-session';
import { hasSession, createSession, sendKeys, capturePane, sendMessageWithEnter } from '@/lib/tmux';
import { CLAUDE_PROMPT_PATTERN, CLAUDE_SEPARATOR_PATTERN } from '@/lib/cli-patterns';

describe('claude-session - Issue #152 improvements', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
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
  });

  describe('Pattern constants usage (DRY-001, DRY-002)', () => {
    it('should use CLAUDE_PROMPT_PATTERN from cli-patterns', () => {
      // Verify the pattern is the expected one
      expect(CLAUDE_PROMPT_PATTERN).toBeInstanceOf(RegExp);
      expect(CLAUDE_PROMPT_PATTERN.test('> ')).toBe(true);
      expect(CLAUDE_PROMPT_PATTERN.test('> /work-plan')).toBe(true);
    });

    it('should use CLAUDE_SEPARATOR_PATTERN from cli-patterns', () => {
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

      // Advance past timeout
      await vi.advanceTimersByTimeAsync(timeout + 100);

      await expect(promise).rejects.toThrow(`Prompt detection timeout (${timeout}ms)`);
    });

    it('should use default timeout when not specified', async () => {
      const sessionName = 'mcbd-claude-test-worktree';
      vi.mocked(capturePane).mockResolvedValue('Still processing...');

      const promise = waitForPrompt(sessionName);

      // Advance past default timeout (CLAUDE_PROMPT_WAIT_TIMEOUT = 5000ms)
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_WAIT_TIMEOUT + 100);

      await expect(promise).rejects.toThrow(`Prompt detection timeout (${CLAUDE_PROMPT_WAIT_TIMEOUT}ms)`);
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

      // Advance past CLAUDE_INIT_TIMEOUT
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);

      await expect(promise).rejects.toThrow(`Claude initialization timeout (${CLAUDE_INIT_TIMEOUT}ms)`);
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

    it('should detect separator using CLAUDE_SEPARATOR_PATTERN (DRY-002)', async () => {
      vi.mocked(capturePane).mockResolvedValue('────────────────────');

      const options = {
        worktreeId: 'test-worktree',
        worktreePath: '/path/to/worktree',
      };

      const promise = startClaudeSession(options);

      // Advance through poll and stability delay
      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_POLL_INTERVAL + CLAUDE_POST_PROMPT_DELAY);

      await expect(promise).resolves.toBeUndefined();
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
      vi.mocked(sendMessageWithEnter).mockResolvedValue();
    });

    it('should verify prompt state before sending (CONS-006)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      await sendMessageToClaude('test-worktree', 'Hello Claude');

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

      // Advance through poll interval for waitForPrompt
      await vi.advanceTimersByTimeAsync(CLAUDE_PROMPT_POLL_INTERVAL);

      await promise;

      expect(callCount).toBeGreaterThanOrEqual(2);
    });

    it('should use sendMessageWithEnter instead of raw sendKeys (Task-PRE-003)', async () => {
      vi.mocked(capturePane).mockResolvedValue('> ');

      await sendMessageToClaude('test-worktree', 'Hello Claude');

      // Should call sendMessageWithEnter once (unified pattern)
      expect(sendMessageWithEnter).toHaveBeenCalledTimes(1);
      expect(sendMessageWithEnter).toHaveBeenCalledWith(
        'mcbd-claude-test-worktree', 'Hello Claude', 100
      );
    });

    it('should throw error if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(sendMessageToClaude('test-worktree', 'Hello')).rejects.toThrow(
        'Claude session mcbd-claude-test-worktree does not exist'
      );
    });

    it('should warn and send anyway if prompt not detected within timeout', async () => {
      vi.mocked(capturePane).mockResolvedValue('Still processing...');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const promise = sendMessageToClaude('test-worktree', 'Hello');

      // Advance past the 10000ms timeout used in sendMessageToClaude
      await vi.advanceTimersByTimeAsync(10000 + 100);

      // Should resolve (not reject) - sends message anyway after timeout
      await expect(promise).resolves.toBeUndefined();
      expect(warnSpy).toHaveBeenCalledWith(
        '[sendMessageToClaude] Prompt not detected, sending anyway'
      );
      // Message should still be sent via sendMessageWithEnter
      expect(sendMessageWithEnter).toHaveBeenCalledWith(
        'mcbd-claude-test-worktree', 'Hello', 100
      );

      warnSpy.mockRestore();
    });
  });

  describe('getSessionName()', () => {
    it('should generate session name with mcbd-claude- prefix', () => {
      expect(getSessionName('test-worktree')).toBe('mcbd-claude-test-worktree');
    });
  });
});
