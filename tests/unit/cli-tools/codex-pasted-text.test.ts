/**
 * Unit tests for CodexTool.sendMessage() - Pasted text detection
 * Issue #212: Pasted text detection for Codex CLI
 * Issue #393: Updated to use sendSpecialKey instead of direct exec()
 *
 * Separate test file to avoid vi.mock affecting existing codex.test.ts
 * tests (SF-S3-002: isRunning test uses real tmux).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux module
// Issue #393: Added sendSpecialKey and sendSpecialKeys (codex.ts no longer uses child_process directly)
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  capturePane: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
  sendSpecialKeys: vi.fn(),
}));

// Mock pasted-text-helper (MF-S2-002: codex.ts only imports the helper)
vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
}));

// Mock sendSpecialKey from tmux (needed by base class)
vi.mock('@/lib/cli-tools/validation', () => ({
  validateSessionName: vi.fn(),
}));

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, sendKeys, sendSpecialKey } from '@/lib/tmux';
import { detectAndResendIfPastedText } from '@/lib/pasted-text-helper';

const TEST_WORKTREE_ID = 'test-worktree';
const TEST_SESSION_NAME = 'mcbd-codex-test-worktree';

describe('CodexTool.sendMessage() - Pasted text detection (Issue #212)', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
    vi.mocked(hasSession).mockResolvedValue(true);
    vi.mocked(sendKeys).mockResolvedValue();
    vi.mocked(sendSpecialKey).mockResolvedValue();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // MF-001: Single-line messages should skip detection
  it('should skip Pasted text detection for single-line messages', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'hello');

    // detectAndResendIfPastedText should NOT be called
    expect(detectAndResendIfPastedText).not.toHaveBeenCalled();
  });

  // Multi-line messages should trigger detection
  it('should call detectAndResendIfPastedText for multi-line messages', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'line1\nline2');

    // detectAndResendIfPastedText should be called after sendSpecialKey(C-m)
    expect(detectAndResendIfPastedText).toHaveBeenCalledWith(TEST_SESSION_NAME);
    expect(detectAndResendIfPastedText).toHaveBeenCalledTimes(1);
  });

  // SF-003: Verify call order - sendKeys(message) -> sendSpecialKey(C-m) -> detectAndResendIfPastedText
  // Issue #393: Updated from execAsync(C-m) to sendSpecialKey(C-m)
  it('should call detectAndResendIfPastedText after sendSpecialKey(C-m)', async () => {
    const callOrder: string[] = [];

    vi.mocked(sendKeys).mockImplementation(async () => {
      callOrder.push('sendKeys');
    });

    vi.mocked(sendSpecialKey).mockImplementation(async () => {
      callOrder.push('sendSpecialKey');
    });

    vi.mocked(detectAndResendIfPastedText).mockImplementation(async () => {
      callOrder.push('detectAndResendIfPastedText');
    });

    await tool.sendMessage(TEST_WORKTREE_ID, 'line1\nline2');

    // Verify order: sendKeys (message) -> sendSpecialKey (C-m Enter) -> detectAndResendIfPastedText
    expect(callOrder).toEqual([
      'sendKeys',       // sendKeys(message, false)
      'sendSpecialKey', // sendSpecialKey(sessionName, 'C-m')
      'detectAndResendIfPastedText',  // Pasted text detection
    ]);
  });

  // Verify existing send flow is maintained
  it('should maintain existing sendKeys + sendSpecialKey flow for message delivery', async () => {
    await tool.sendMessage(TEST_WORKTREE_ID, 'single line');

    // sendKeys should be called once for the message
    expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, 'single line', false);
    // sendSpecialKey should be called for C-m (Enter)
    expect(sendSpecialKey).toHaveBeenCalledWith(TEST_SESSION_NAME, 'C-m');
  });
});
