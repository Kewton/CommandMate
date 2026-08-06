/**
 * Integration tests for Issue #201: Trust dialog auto-response
 * Verifies the acceptance criteria for automatic Enter sending
 * when Claude CLI displays a trust dialog on first workspace access.
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger module (Issue #480)
const { mockLogger } = vi.hoisted(() => {
  const mockLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockLogger };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

// Mock tmux module before importing claude-session
vi.mock('@/lib/tmux/tmux', () => ({
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
} from '@/lib/session/claude-session';
import {
  CLAUDE_TRUST_DIALOG_PATTERN,
  CLAUDE_PROMPT_PATTERN,
} from '@/lib/detection/cli-patterns';
import { hasSession, createSession, sendKeys, capturePane } from '@/lib/tmux/tmux';
import { isSessionStartTimeoutError } from '@/lib/session/session-start-error';
import { useIsolatedAgentHooksDir } from '@tests/helpers/agent-hooks-dir';

// Issue #1722 writes a hooks settings file on every session start.
useIsolatedAgentHooksDir('trust-dialog');

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

    it('AC4: should output info-level log on auto-response', async () => {
      mockLogger.info.mockClear();

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

      // Verify logger.info was called with trust dialog detection message
      const trustLogCalls = mockLogger.info.mock.calls.filter((call) =>
        String(call[0]).includes('trust-dialog')
      );
      expect(trustLogCalls.length).toBeGreaterThanOrEqual(1);
    });

    /**
     * AC5 asserts the *cause* again, as it did when Issue #201 first wrote it.
     *
     * History, checked rather than recalled. `841f8a37` (#201) asserted
     * `'Claude initialization timeout'`. `b17c7efb` (#1102) replaced it with the
     * generic `'Failed to start Claude session'` and added a comment citing
     * "SEC-SF-002: detailed error is logged server-side, not surfaced to the
     * client". Both halves of that citation are wrong as a justification, and
     * the comment is corrected here rather than left standing behind a new
     * expectation:
     *
     *  - #1102 was not a security decision. Its title is "test: integration
     *    \u30B9\u30A4\u30FC\u30C8\u306E\u65E2\u5B58 drift \u89E3\u6D88\uFF08500 \u306B\u306A\u308B API \u7CFB\u30E2\u30C3\u30AF/\u671F\u5F85\u5024\u306E\u8FFD\u968F + CI \u8FFD\u52A0\uFF09"
     *    and its scope says, in as many words, \u30B9\u30B3\u30FC\u30D7\u5916: \u30D7\u30ED\u30C0\u30AF\u30C8\u5B9F\u88C5\u306E\u6319\u52D5\u5909\u66F4
     *    \uFF08\u30C6\u30B9\u30C8/\u30E2\u30C3\u30AF\u306E\u8FFD\u968F\u306E\u307F\u3002\u5B9F\u88C5\u304C\u6B63\u3057\u3044\u524D\u63D0\uFF09. The assertion was changed to
     *    follow the implementation of the day, and the rationale was written
     *    afterwards to explain what the implementation happened to do.
     *  - SEC-SF-002 does not say "collapse the cause". Every other use of the
     *    marker in src/ is input validation (worktreeId / duration whitelist /
     *    MAX_SEARCH_QUERY_LENGTH), 500-character content truncation, or a
     *    User-Agent header. The one that touches error responses at all is
     *    `src/app/api/worktrees/[id]/files/[...path]/route.ts`: "Error responses
     *    without absolute paths". That is a rule about paths, not about causes.
     *
     * Issue #1637 keeps the part of SEC-SF-002 that is real \u2014 an unexpected
     * failure still collapses to the fixed generic string, and no message ever
     * carries a path or raw pane output \u2014 while letting the caller learn that
     * the session is *starting*, which is the whole point of that Issue. The
     * leak-freedom is asserted below instead of being approximated by "the
     * message is a constant".
     */
    it('AC5: should report an initialization timeout if the prompt never appears', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      // Trust dialog appears but prompt never comes after Enter
      const paneOutput = ' \u276F 1. Yes, I trust this folder\n   2. No, exit';
      vi.mocked(capturePane).mockResolvedValue(paneOutput);

      const promise = startClaudeSession({
        worktreeId: 'stuck-workspace',
        worktreePath: '/path/to/stuck/workspace',
      });
      const captured = promise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);
      const error = (await captured) as Error;

      // The session and the CLI process are both still alive; only the prompt
      // was not observed. That is what the caller has to be able to act on.
      expect(isSessionStartTimeoutError(error)).toBe(true);
      expect(error.message).toContain('initialization timeout');
      expect(error.message).toMatch(/retry/i);
      // Derived from the constant, not written as "60s": pinning the literal is
      // what let this expectation drift away from the implementation twice.
      expect(error.message).toContain(`${Math.round(CLAUDE_INIT_TIMEOUT / 1000)}s`);
    });

    it('AC5b: the timeout message leaks no path, pane output or stack frame', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue();
      vi.mocked(sendKeys).mockResolvedValue();

      const paneOutput = ' \u276F 1. Yes, I trust this folder\n   2. No, exit';
      vi.mocked(capturePane).mockResolvedValue(paneOutput);

      const promise = startClaudeSession({
        worktreeId: 'stuck-workspace',
        worktreePath: '/path/to/stuck/workspace',
      });
      const captured = promise.catch((error: unknown) => error);

      await vi.advanceTimersByTimeAsync(CLAUDE_INIT_TIMEOUT + 1000);
      const message = ((await captured) as Error).message;

      // The worktree path, and the resolved CLI binary path from the
      // child_process mock above \u2014 neither is the caller's to see.
      expect(message).not.toContain('/path/to/stuck/workspace');
      expect(message).not.toContain('/usr/local/bin/claude');
      // Nothing that merely looks like an absolute path either.
      expect(message).not.toMatch(/(?:^|[\s'"(])\/[\w.-]+\//);
      // Raw capture output: the pane is arbitrary CLI text and may hold anything.
      expect(message).not.toContain(paneOutput);
      expect(message).not.toContain('Yes, I trust this folder');
      // Not assembled from a stack trace.
      expect(message).not.toMatch(/\n\s+at\s/);

      // What it does name is the tmux session, which is derived from the
      // worktreeId the caller itself supplied \u2014 not new information.
      expect(message).toContain('mcbd-claude-stuck-workspace');
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
