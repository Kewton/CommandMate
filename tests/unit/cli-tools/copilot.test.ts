/**
 * Unit tests for CopilotTool
 * Issue #545: Copilot CLI support
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CopilotTool } from '@/lib/cli-tools/copilot';
import type { CLIToolType } from '@/lib/cli-tools/types';

// Mock child_process execFile for isInstalled tests
vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

// Mock tmux functions
vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(false),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
}));

vi.mock('@/lib/pasted-text-helper', () => ({
  detectAndResendIfPastedText: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    withContext: () => ({
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }),
  }),
}));

describe('CopilotTool', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    tool = new CopilotTool();
    vi.clearAllMocks();
  });

  describe('Tool properties', () => {
    it('should have correct id', () => {
      expect(tool.id).toBe('copilot');
    });

    it('should have correct name', () => {
      expect(tool.name).toBe('Copilot');
    });

    it('should have correct command (gh)', () => {
      expect(tool.command).toBe('gh');
    });

    it('should have CLIToolType as id type', () => {
      const id: CLIToolType = tool.id;
      expect(id).toBe('copilot');
    });
  });

  describe('getSessionName', () => {
    it('should generate session name with correct format', () => {
      const sessionName = tool.getSessionName('feature-foo');
      expect(sessionName).toBe('mcbd-copilot-feature-foo');
    });

    it('should throw error for worktree id with slashes (security)', () => {
      expect(() => tool.getSessionName('feature/issue/123')).toThrow(/Invalid session name format/);
    });
  });

  describe('isInstalled', () => {
    it('should return true when both gh and copilot extension are available', async () => {
      const { execFile } = await import('child_process');
      const mockExecFile = vi.mocked(execFile);
      // First call: gh --version (success)
      // Second call: gh copilot --help (success)
      mockExecFile.mockImplementation((_command: string, args: unknown, _options: unknown, callback?: unknown) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        if (cb) {
          cb(null, 'success', '');
        }
        return {} as import('child_process').ChildProcess;
      });

      const installed = await tool.isInstalled();
      expect(installed).toBe(true);
      expect(mockExecFile).toHaveBeenCalledTimes(2);
    });

    it('should return false when gh is installed but copilot extension is not', async () => {
      const { execFile } = await import('child_process');
      const mockExecFile = vi.mocked(execFile);
      let callCount = 0;
      mockExecFile.mockImplementation((_command: string, args: unknown, _options: unknown, callback?: unknown) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        callCount++;
        if (callCount === 1) {
          // gh --version succeeds
          cb(null, 'gh version 2.0.0', '');
        } else {
          // gh copilot --help fails
          cb(new Error('unknown command "copilot"'), '', 'unknown command "copilot"');
        }
        return {} as import('child_process').ChildProcess;
      });

      const installed = await tool.isInstalled();
      expect(installed).toBe(false);
    });

    it('should return false when gh is not installed', async () => {
      const { execFile } = await import('child_process');
      const mockExecFile = vi.mocked(execFile);
      mockExecFile.mockImplementation((_command: string, _args: unknown, _options: unknown, callback?: unknown) => {
        const cb = callback as (error: Error | null, stdout: string, stderr: string) => void;
        cb(new Error('command not found: gh'), '', '');
        return {} as import('child_process').ChildProcess;
      });

      const installed = await tool.isInstalled();
      expect(installed).toBe(false);
    });
  });

  describe('isRunning', () => {
    it('should check if session is running', async () => {
      const running = await tool.isRunning('test-worktree');
      expect(typeof running).toBe('boolean');
    });

    it('should return false for non-existent session', async () => {
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
      expect(tool.id).toBe('copilot');
      expect(tool.name).toBe('Copilot');
      expect(tool.command).toBe('gh');
    });
  });
});
