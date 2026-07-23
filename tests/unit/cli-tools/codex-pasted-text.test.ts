/**
 * Unit tests for CodexTool.sendMessage() - submit-verified sending
 * Issue #212 -> #1471: paste recovery + submit verification is now handled by the
 * shared submit-verified sender, applied to EVERY message (no `\n` gate).
 *
 * Separate test file to avoid vi.mock affecting existing codex.test.ts
 * tests (SF-S3-002: isRunning test uses real tmux).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux module
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
}));

// Mock the shared submit-verified sender (Issue #1471: codex delegates to it)
vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// Mock sendSpecialKey from tmux (needed by base class)
vi.mock('@/lib/cli-tools/validation', () => ({
  validateSessionName: vi.fn(),
}));

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, sendKeys, sendSpecialKey, capturePane } from '@/lib/tmux/tmux';
import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';

const TEST_WORKTREE_ID = 'test-worktree';
const TEST_SESSION_NAME = 'mcbd-codex-test-worktree';

describe('CodexTool.sendMessage() - submit-verified sending (Issue #1471)', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKey).mockResolvedValue();
    vi.mocked(sendMessageWithSubmitVerification).mockResolvedValue(undefined);
    // waitForPrompt needs capturePane to return output matching CODEX_PROMPT_PATTERN (›)
    vi.mocked(capturePane).mockResolvedValue('› ');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // No `\n` gate anymore: single-line messages are verified too.
  it('should delegate single-line messages to the submit-verified sender', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'hello');

    expect(sendMessageWithSubmitVerification).toHaveBeenCalledTimes(1);
    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: TEST_SESSION_NAME,
        message: 'hello',
        cliToolId: 'codex',
      })
    );
  });

  it('should delegate multi-line messages to the submit-verified sender', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'line1\nline2');

    expect(sendMessageWithSubmitVerification).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionName: TEST_SESSION_NAME,
        message: 'line1\nline2',
        cliToolId: 'codex',
      })
    );
  });

  // The raw body+C-m batch must never be issued directly by the tool anymore.
  it('should not issue a batched body+Enter send-keys itself', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'single line');

    // sendKeys is only used for dialog handling / launch, never `(session, msg, true)`.
    expect(sendKeys).not.toHaveBeenCalledWith(TEST_SESSION_NAME, 'single line', true);
  });

  // waitForPrompt must still run before delegating (readiness gate preserved).
  it('should verify prompt readiness before delegating the send', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'hello');

    expect(capturePane).toHaveBeenCalled();
    expect(sendMessageWithSubmitVerification).toHaveBeenCalled();
  });
});
