/**
 * Unit tests for OpenCodeTool
 * Issue #379: OpenCode CLI tool implementation
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OpenCodeTool, OPENCODE_EXIT_COMMAND, OPENCODE_INIT_WAIT_MS } from '@/lib/cli-tools/opencode';

// Mock tmux module
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn(),
  killSession: vi.fn(),
}));

// Mock opencode-config module
vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

// Mock pasted-text-helper
vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn(),
}));

// Mock child_process
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

vi.mock('util', async (importOriginal) => {
  const actual = await importOriginal<typeof import('util')>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue(undefined),
  };
});

import {
  hasSession,
  createSession,
  sendKeys,
  sendSpecialKey,
  killSession,
} from '@/lib/tmux';
import { ensureOpencodeConfig } from '@/lib/cli-tools/opencode-config';
import { detectAndResendIfPastedText } from '@/lib/pasted-text-helper';

describe('OpenCodeTool', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.restoreAllMocks();
    tool = new OpenCodeTool();
  });

  describe('properties', () => {
    it('should have id = "opencode"', () => {
      expect(tool.id).toBe('opencode');
    });

    it('should have name = "OpenCode"', () => {
      expect(tool.name).toBe('OpenCode');
    });

    it('should have command = "opencode"', () => {
      expect(tool.command).toBe('opencode');
    });
  });

  describe('constants', () => {
    it('should export OPENCODE_EXIT_COMMAND as /exit [D1-006]', () => {
      expect(OPENCODE_EXIT_COMMAND).toBe('/exit');
    });

    it('should export OPENCODE_INIT_WAIT_MS as 15000', () => {
      expect(OPENCODE_INIT_WAIT_MS).toBe(15000);
    });
  });

  describe('getSessionName()', () => {
    it('should return mcbd-opencode-{worktreeId} format', () => {
      const sessionName = tool.getSessionName('test-123');
      expect(sessionName).toBe('mcbd-opencode-test-123');
    });
  });

  describe('isRunning()', () => {
    it('should delegate to hasSession()', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      const result = await tool.isRunning('test-123');
      expect(result).toBe(true);
      expect(hasSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      const result = await tool.isRunning('test-123');
      expect(result).toBe(false);
    });
  });

  describe('startSession()', () => {
    it('should skip if session already exists', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);

      await tool.startSession('test-123', '/test/path');

      expect(createSession).not.toHaveBeenCalled();
    });

    it('should create session and start opencode TUI', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(createSession).mockResolvedValue(undefined);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(ensureOpencodeConfig).mockResolvedValue(undefined);

      // Speed up test by mocking setTimeout
      vi.useFakeTimers();
      const promise = tool.startSession('test-123', '/test/path');
      // Advance through all setTimeout calls
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      // Verify ensureOpencodeConfig was called
      expect(ensureOpencodeConfig).toHaveBeenCalledWith('/test/path');

      // Verify createSession was called with correct options
      expect(createSession).toHaveBeenCalledWith({
        sessionName: 'mcbd-opencode-test-123',
        workingDirectory: '/test/path',
        historyLimit: 50000,
      });

      // Verify opencode command was sent
      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', 'opencode', true);
    });
  });

  describe('sendMessage()', () => {
    it('should throw if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendMessage('test-123', 'hello'))
        .rejects.toThrow('does not exist');
    });

    it('should send message via sendKeys and Enter', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKey).mockResolvedValue(undefined);

      vi.useFakeTimers();
      const promise = tool.sendMessage('test-123', 'hello');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', 'hello', false);
      expect(sendSpecialKey).toHaveBeenCalledWith('mcbd-opencode-test-123', 'C-m');
    });

    it('should call detectAndResendIfPastedText for multi-line messages', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKey).mockResolvedValue(undefined);
      vi.mocked(detectAndResendIfPastedText).mockResolvedValue(undefined);

      vi.useFakeTimers();
      const promise = tool.sendMessage('test-123', 'line1\nline2');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(detectAndResendIfPastedText).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    it('should NOT call detectAndResendIfPastedText for single-line messages', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(sendSpecialKey).mockResolvedValue(undefined);

      vi.useFakeTimers();
      const promise = tool.sendMessage('test-123', 'single line');
      await vi.runAllTimersAsync();
      vi.useRealTimers();

      expect(detectAndResendIfPastedText).not.toHaveBeenCalled();
    });
  });

  describe('killSession()', () => {
    it('should send /exit and then kill session if still running [D1-006]', async () => {
      vi.mocked(hasSession)
        .mockResolvedValueOnce(true)   // First check: session exists
        .mockResolvedValueOnce(true);  // Second check: still exists after /exit
      vi.mocked(sendKeys).mockResolvedValue(undefined);
      vi.mocked(killSession).mockResolvedValue(true);

      await tool.killSession('test-123');

      // Should send /exit command
      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', OPENCODE_EXIT_COMMAND, true);
      // Should fall back to kill-session
      expect(killSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });

    it('should not kill if /exit successfully terminated the session', async () => {
      vi.mocked(hasSession)
        .mockResolvedValueOnce(true)   // First check: session exists
        .mockResolvedValueOnce(false); // Second check: session gone after /exit
      vi.mocked(sendKeys).mockResolvedValue(undefined);

      await tool.killSession('test-123');

      expect(sendKeys).toHaveBeenCalledWith('mcbd-opencode-test-123', OPENCODE_EXIT_COMMAND, true);
      expect(killSession).not.toHaveBeenCalled();
    });

    it('should handle non-existent session gracefully', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      vi.mocked(killSession).mockResolvedValue(false);

      await tool.killSession('test-123');
      // When session doesn't exist, killSession (tmux) is still called as cleanup
      expect(killSession).toHaveBeenCalledWith('mcbd-opencode-test-123');
    });
  });
});
