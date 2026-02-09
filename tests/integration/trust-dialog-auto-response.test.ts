/**
 * Integration tests for Issue #201: Trust dialog auto-response
 * Verifies the acceptance criteria for automatic Enter sending
 * when Claude CLI displays a trust dialog on first workspace access.
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
  CLAUDE_INIT_TIMEOUT,
  CLAUDE_INIT_POLL_INTERVAL,
  CLAUDE_POST_PROMPT_DELAY,
} from '@/lib/claude-session';
import {
  CLAUDE_TRUST_DIALOG_PATTERN,
  CLAUDE_PROMPT_PATTERN,
} from '@/lib/cli-patterns';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux';

describe('Issue #201: Trust dialog auto-response - Acceptance Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('Scenario 1: New workspace first access - trust dialog auto-response', () => {
    it('AC1: should auto-send Enter when trust dialog is displayed', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      // Simulate: trust dialog appears first, then prompt after Enter
      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 2) {
          return 'Quick safety check: Is this a project you created or one you trust?\n\n \u276F 1. Yes, I trust this folder\n   2. No, exit';
        }
        return '\u276F ';
      });

      const promise = startClaudeSession({
        worktreeId: 'new-workspace',
        worktreePath: '/path/to/new/workspace',
      });

      await vi.advanceTimersByTimeAsync(
        CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY
      );

      await expect(promise).resolves.toBeUndefined();

      // Verify Enter was sent exactly once for trust dialog
      const sendKeysCalls = vi.mocked(sendKeys).mock.calls;
      const trustDialogEnterCalls = sendKeysCalls.filter(
        (call) => call[1] === '' && call[2] === true
      );
      expect(trustDialogEnterCalls.length).toBe(1);
    });

    it('AC3: should reach normal prompt state after trust dialog auto-response', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return ' \u276F 1. Yes, I trust this folder\n   2. No, exit';
        }
        return '\u276F ';
      });

      const promise = startClaudeSession({
        worktreeId: 'new-workspace',
        worktreePath: '/path/to/new/workspace',
      });

      await vi.advanceTimersByTimeAsync(
        CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY
      );

      // Session should resolve successfully (prompt detected after dialog)
      await expect(promise).resolves.toBeUndefined();
    });

    it('AC4: should output info-level console log on auto-response', async () => {
      const consoleSpy = vi.spyOn(console, 'log');

      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return ' \u276F 1. Yes, I trust this folder\n   2. No, exit';
        }
        return '\u276F ';
      });

      const promise = startClaudeSession({
        worktreeId: 'new-workspace',
        worktreePath: '/path/to/new/workspace',
      });

      await vi.advanceTimersByTimeAsync(
        CLAUDE_INIT_POLL_INTERVAL * 3 + CLAUDE_POST_PROMPT_DELAY
      );

      await promise;

      // Verify console.log was called with trust dialog message
      const trustLogCalls = consoleSpy.mock.calls.filter((call) =>
        String(call[0]).includes('Trust dialog detected')
      );
      expect(trustLogCalls.length).toBe(1);

      consoleSpy.mockRestore();
    });

    it('AC5: should timeout if prompt never appears after trust dialog Enter', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      // Trust dialog appears but prompt never comes after Enter
      vi.mocked(capturePane).mockResolvedValue(
        ' \u276F 1. Yes, I trust this folder\n   2. No, exit'
      );

      const promise = startClaudeSession({
        worktreeId: 'stuck-workspace',
        worktreePath: '/path/to/stuck/workspace',
      });

      const assertion = expect(promise).rejects.toThrow(
        'Claude initialization timeout'
      );

      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);

      await assertion;
    });
  });

  describe('Scenario 2: Existing workspace - no dialog regression test', () => {
    it('AC6: should initialize normally without trust dialog', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount < 3) {
          return 'Starting Claude...';
        }
        return '> ';
      });

      const promise = startClaudeSession({
        worktreeId: 'existing-workspace',
        worktreePath: '/path/to/existing/workspace',
      });

      await vi.advanceTimersByTimeAsync(
        CLAUDE_INIT_POLL_INTERVAL * 4 + CLAUDE_POST_PROMPT_DELAY
      );

      await expect(promise).resolves.toBeUndefined();

      // Verify NO extra Enter was sent (only claudePath Enter)
      const sendKeysCalls = vi.mocked(sendKeys).mock.calls;
      const emptyEnterCalls = sendKeysCalls.filter(
        (call) => call[1] === '' && call[2] === true
      );
      expect(emptyEnterCalls.length).toBe(0);
    });
  });

  describe('Scenario 3: Duplicate send prevention guard', () => {
    it('AC2: should send Enter only once even when dialog persists across multiple polls', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          // Dialog persists for 3 poll cycles
          return 'Quick safety check: Is this a project you created or one you trust?\n\n \u276F 1. Yes, I trust this folder\n   2. No, exit';
        }
        return '\u276F ';
      });

      const promise = startClaudeSession({
        worktreeId: 'dup-guard-test',
        worktreePath: '/path/to/workspace',
      });

      await vi.advanceTimersByTimeAsync(
        CLAUDE_INIT_POLL_INTERVAL * 5 + CLAUDE_POST_PROMPT_DELAY
      );

      await expect(promise).resolves.toBeUndefined();

      // Verify Enter was sent exactly once despite dialog appearing 3 times
      const sendKeysCalls = vi.mocked(sendKeys).mock.calls;
      const trustDialogEnterCalls = sendKeysCalls.filter(
        (call) => call[1] === '' && call[2] === true
      );
      expect(trustDialogEnterCalls.length).toBe(1);
    });
  });

  describe('Scenario 4: Pattern match accuracy', () => {
    it('AC8: CLAUDE_TRUST_DIALOG_PATTERN should match full trust dialog text', () => {
      const fullDialog =
        'Quick safety check: Is this a project you created or one you trust?\n\n \u276F 1. Yes, I trust this folder\n   2. No, exit';
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(fullDialog)).toBe(true);
    });

    it('AC8: CLAUDE_TRUST_DIALOG_PATTERN should match dialog with tmux padding', () => {
      const paddedDialog =
        '\n\n  Some header\nQuick safety check: Is this a project you created or one you trust?\n\n \u276F 1. Yes, I trust this folder\n   2. No, exit\n\n';
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(paddedDialog)).toBe(true);
    });

    it('AC8: CLAUDE_TRUST_DIALOG_PATTERN should NOT match regular CLI output', () => {
      const normalOutput =
        '\u276F git status\nOn branch main\nnothing to commit, working tree clean';
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(normalOutput)).toBe(false);
    });

    it('AC8: CLAUDE_TRUST_DIALOG_PATTERN should NOT match "No, exit" option alone', () => {
      const noOption = 'No, exit';
      expect(CLAUDE_TRUST_DIALOG_PATTERN.test(noOption)).toBe(false);
    });

    it('CLAUDE_PROMPT_PATTERN should still match standard prompts', () => {
      expect(CLAUDE_PROMPT_PATTERN.test('> ')).toBe(true);
      expect(CLAUDE_PROMPT_PATTERN.test('\u276F ')).toBe(true);
      expect(CLAUDE_PROMPT_PATTERN.test('\u276F /work-plan')).toBe(true);
    });
  });
});
