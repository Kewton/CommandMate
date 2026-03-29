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

  describe('extractSlashCommand (via sendMessage behavior)', () => {
    it('should recognize /model as a selection list command', () => {
      // Access private method via any cast for testing
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/model')).toBe('model');
      expect(extract.call(tool, '/agent')).toBe('agent');
      expect(extract.call(tool, '/theme')).toBe('theme');
    });

    it('should return null for non-slash messages', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, 'hello world')).toBeNull();
      expect(extract.call(tool, '')).toBeNull();
    });

    it('should extract command name from slash command with args', () => {
      const extract = (tool as unknown as { extractSlashCommand(m: string): string | null }).extractSlashCommand;
      expect(extract.call(tool, '/help commands')).toBe('help');
      expect(extract.call(tool, '/compact  ')).toBe('compact');
    });
  });

  describe('sendModelCommand', () => {
    it('should be a public method', () => {
      expect(typeof tool.sendModelCommand).toBe('function');
    });

    it('should throw if session does not exist', async () => {
      const { hasSession } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(false);

      await expect(tool.sendModelCommand('test-wt', 'gpt-5-mini'))
        .rejects.toThrow(/does not exist/);
    });

    it('should send /model command and Enter to session', async () => {
      vi.useFakeTimers();

      const { hasSession, sendKeys, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);
      await promise;

      expect(sendKeys).toHaveBeenCalledWith(
        'mcbd-copilot-test-wt',
        '/model gpt-5-mini',
        true
      );

      vi.useRealTimers();
    });

    it('should send Enter to confirm selection list when detected', async () => {
      vi.useFakeTimers();

      const { hasSession, capturePane, sendSpecialKey } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);

      let callCount = 0;
      vi.mocked(capturePane).mockImplementation(async () => {
        callCount++;
        if (callCount <= 3) {
          return 'Search models...';
        }
        return '> ';
      });

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);
      await promise;

      expect(sendSpecialKey).toHaveBeenCalledWith(
        'mcbd-copilot-test-wt',
        'C-m'
      );

      vi.useRealTimers();
    });

    it('should wait for prompt recovery after model switch', async () => {
      vi.useFakeTimers();

      const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('> ');

      const promise = tool.sendModelCommand('test-wt', 'gpt-5-mini');
      await vi.advanceTimersByTimeAsync(40000);

      await expect(promise).resolves.toBeUndefined();

      vi.useRealTimers();
    });
  });

  describe('waitForSelectionList returns boolean', () => {
    it('should return true when selection list is detected', async () => {
      const { hasSession, capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(hasSession).mockResolvedValue(true);
      vi.mocked(capturePane).mockResolvedValue('Search models...');

      // Access private method for testing
      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const result = await waitForSelectionList.call(tool, 'mcbd-copilot-test');
      expect(result).toBe(true);
    });

    it('should return false when selection list times out', async () => {
      vi.useFakeTimers();

      const { capturePane } = await import('@/lib/tmux/tmux');
      vi.mocked(capturePane).mockResolvedValue('some other output');

      const waitForSelectionList = (tool as unknown as {
        waitForSelectionList(s: string): Promise<boolean>
      }).waitForSelectionList;

      const promise = waitForSelectionList.call(tool, 'mcbd-copilot-test');

      // Advance timers past the 5s timeout
      await vi.advanceTimersByTimeAsync(6000);

      const result = await promise;
      expect(result).toBe(false);

      vi.useRealTimers();
    });
  });
});
