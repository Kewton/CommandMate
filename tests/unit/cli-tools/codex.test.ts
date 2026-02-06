/**
 * Unit tests for CodexTool
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock tmux module before importing CodexTool
vi.mock('@/lib/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  sendKeys: vi.fn(),
  sendTextViaBuffer: vi.fn(),
  killSession: vi.fn(),
  sendSpecialKey: vi.fn(),
}));

// Mock child_process for killSession's execAsync
vi.mock('child_process', () => ({
  exec: vi.fn(
    (
      _cmd: string,
      opts: Record<string, unknown> | ((error: Error | null, result: { stdout: string; stderr: string }) => void),
      cb?: (error: Error | null, result: { stdout: string; stderr: string }) => void
    ) => {
      const callback = typeof opts === 'function' ? opts : cb;
      if (callback) {
        callback(null, { stdout: '', stderr: '' });
      }
      return {};
    }
  ),
}));

import { CodexTool } from '@/lib/cli-tools/codex';
import { hasSession, sendTextViaBuffer } from '@/lib/tmux';
import { exec } from 'child_process';

describe('CodexTool', () => {
  let tool: CodexTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CodexTool();
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('codex');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Codex CLI');
    });

    it('should have correct command', () => {
      expect(tool.command).toBe('codex');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('codex');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-codex-feature-foo');
    });

    it('should handle worktree id with slashes', () => {
      const sessionName = tool.getSessionName('feature/issue/123');
      expect(sessionName).toBe('mcbd-codex-feature/issue/123');
    });
  });

  describe('isInstalled', () => {
    it('should check if Codex is installed', async () => {
      const installed = await tool.isInstalled();
      expect(typeof installed).toBe('boolean');
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      const running = await tool.isRunning('test-worktree');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);
      const running = await tool.isRunning('non-existent-worktree-xyz');
      expect(running).toBe(false);
    });
  });

  describe('Interface implementation', () => {
    it('should implement all required methods', () => {
      expect(typeof tool.isInstalled).toBe('function');
      expect(typeof tool.isRunning).toBe('function');
      expect(typeof tool.startSession).toBe('function');
      expect(typeof tool.sendMessage).toBe('function');
      expect(typeof tool.killSession).toBe('function');
      expect(typeof tool.getSessionName).toBe('function');
    });

    it('should have readonly properties', () => {
      expect(tool.id).toBe('codex');
      expect(tool.name).toBe('Codex CLI');
      expect(tool.command).toBe('codex');
    });
  });

  describe('sendMessage', () => {
    it('should use sendTextViaBuffer for message sending', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendTextViaBuffer).mockResolvedValue();

      await tool.sendMessage('test-worktree', 'Hello Codex');

      // sendTextViaBuffer should be called once with correct args
      expect(sendTextViaBuffer).toHaveBeenCalledTimes(1);
      expect(sendTextViaBuffer).toHaveBeenCalledWith(
        'mcbd-codex-test-worktree',
        'Hello Codex',
        true
      );
    });

    it('should not use execAsync for tmux send-keys directly', async () => {
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(sendTextViaBuffer).mockResolvedValue();

      await tool.sendMessage('test-worktree', 'Hello Codex');

      // Verify no tmux send-keys calls via execAsync
      const execCalls = vi.mocked(exec).mock.calls;
      const hasTmuxSendKeys = execCalls.some((call) => {
        const cmd = call[0] as string;
        return cmd.includes('tmux send-keys');
      });
      expect(hasTmuxSendKeys).toBe(false);
    });

    it('should throw error if session does not exist', async () => {
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendMessage('test-worktree', 'Hello')).rejects.toThrow(
        'Codex session mcbd-codex-test-worktree does not exist'
      );
    });
  });
});
