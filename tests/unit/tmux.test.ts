/**
 * Unit tests for tmux session management
 * Issue #393: exec() -> execFile() migration tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'child_process';
import {
  isTmuxAvailable,
  hasSession,
  listSessions,
  createSession,
  sendKeys,
  sendSpecialKey,
  sendSpecialKeys,
  capturePane,
  killSession,
  ensureSession,
  SPECIAL_KEY_VALUES,
} from '@/lib/tmux/tmux';

// Mock child_process execFile (Issue #393: exec -> execFile migration)
vi.mock('child_process', () => ({
  execFile: vi.fn(),
}));

describe('tmux library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isTmuxAvailable', () => {
    it('should return true when tmux is available', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: 'tmux 3.3a', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['-V'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return false when tmux is not available', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('command not found'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(false);
    });

    it('should handle timeout', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        setTimeout(() => {
          callback(new Error('timeout'), { stdout: '', stderr: '' });
        }, 100);
        return {} as ReturnType<typeof execFile>;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(false);
    });
  });

  describe('hasSession', () => {
    it('should return true when session exists', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await hasSession('test-session');
      expect(result).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', 'test-session'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('no sessions'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await hasSession('test-session');
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list all tmux sessions', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, {
          stdout: 'session1|2|1\nsession2|1|0\n',
          stderr: '',
        });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await listSessions();

      expect(result).toEqual([
        { name: 'session1', windows: 2, attached: true },
        { name: 'session2', windows: 1, attached: false },
      ]);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['list-sessions', '-F', '#{session_name}|#{session_windows}|#{session_attached}'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return empty array when no sessions exist', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('no sessions'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await listSessions();
      expect(result).toEqual([]);
    });

    it('should handle empty stdout', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await listSessions();
      expect(result).toEqual([]);
    });
  });

  describe('createSession', () => {
    it('should create session with legacy signature', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await createSession('test-session', '/path/to/cwd');

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd'],
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-t', 'test-session', 'history-limit', '50000'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should create session with options object', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
        historyLimit: 100000,
      });

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd'],
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-t', 'test-session', 'history-limit', '100000'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('failed to create'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await expect(createSession('test-session', '/path/to/cwd')).rejects.toThrow(
        'Failed to create tmux session'
      );
    });
  });

  describe('sendKeys', () => {
    it('should send keys with Enter', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendKeys('test-session', 'echo hello');

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'echo hello', 'C-m'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should send keys without Enter', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendKeys('test-session', 'echo hello', false);

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'echo hello'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should pass single quotes as-is without shell escaping', async () => {
      // D2-003/R3F007: execFile() does not use shell, so no escaping needed
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendKeys('test-session', "echo 'hello'");

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', "echo 'hello'", 'C-m'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('session not found'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await expect(sendKeys('test-session', 'echo hello')).rejects.toThrow(
        'Failed to send keys to tmux session'
      );
    });
  });

  describe('capturePane', () => {
    it('should capture with default lines (legacy)', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: 'output', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await capturePane('test-session');

      expect(result).toBe('output');
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', 'test-session', '-p', '-e', '-S', '-1000', '-E', '-'],
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should capture with specified lines (legacy)', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: 'output', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await capturePane('test-session', 500);

      expect(result).toBe('output');
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', 'test-session', '-p', '-e', '-S', '-500', '-E', '-'],
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should capture with options object', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: 'output', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await capturePane('test-session', {
        startLine: -10000,
        endLine: -1,
      });

      expect(result).toBe('output');
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['capture-pane', '-t', 'test-session', '-p', '-e', '-S', '-10000', '-E', '-1'],
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('session not found'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await expect(capturePane('test-session')).rejects.toThrow('Failed to capture pane');
    });
  });

  describe('killSession', () => {
    it('should kill session and return true', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await killSession('test-session');

      expect(result).toBe(true);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['kill-session', '-t', 'test-session'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error("can't find session"), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await killSession('test-session');
      expect(result).toBe(false);
    });

    it('should return false when no server running', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('no server running'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const result = await killSession('test-session');
      expect(result).toBe(false);
    });

    it('should throw on unexpected errors', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('unexpected error'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await expect(killSession('test-session')).rejects.toThrow(
        'Failed to kill tmux session'
      );
    });
  });

  describe('ensureSession', () => {
    it('should create session if it does not exist', async () => {
      let callCount = 0;
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        callCount++;
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        if (callCount === 1) {
          // has-session fails
          callback(new Error('no session'), { stdout: '', stderr: '' });
        } else {
          // new-session and set-option succeed
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof execFile>;
      });

      await ensureSession('test-session', '/path/to/cwd');

      // Should call has-session, new-session, and set-option
      expect(execFile).toHaveBeenCalledTimes(3);
    });

    it('should not create session if it already exists', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        // has-session succeeds
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await ensureSession('test-session', '/path/to/cwd');

      // Should only call has-session
      expect(execFile).toHaveBeenCalledTimes(1);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', 'test-session'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });
  });

  describe('sendSpecialKey', () => {
    it('should send Escape key to session', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendSpecialKey('test-session', 'Escape');

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'Escape'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should send Ctrl+C key to session', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendSpecialKey('test-session', 'C-c');

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'C-c'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should send Ctrl+D key to session', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendSpecialKey('test-session', 'C-d');

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'C-d'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error if session does not exist', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(new Error('session not found'), { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await expect(sendSpecialKey('test-session', 'Escape')).rejects.toThrow(
        'Failed to send special key'
      );
    });

    // D2-005/R1F004: Runtime validation for invalid keys
    it('should throw error for invalid special key (runtime validation)', async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await expect(sendSpecialKey('test-session', 'rm -rf /' as any)).rejects.toThrow(
        'Invalid special key: rm -rf /'
      );
      // execFile should NOT be called - validation rejects before execution
      expect(execFile).not.toHaveBeenCalled();
    });

    // R2F007: Verify SPECIAL_KEY_VALUES sync with ALLOWED_SINGLE_SPECIAL_KEYS
    it('should accept all SPECIAL_KEY_VALUES as valid keys', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      for (const key of SPECIAL_KEY_VALUES) {
        await expect(sendSpecialKey('test-session', key)).resolves.not.toThrow();
      }
    });
  });

  describe('sendSpecialKeys', () => {
    it('should send valid special keys', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await sendSpecialKeys('test-session', ['Down']);

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', 'Down'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error for invalid key name', async () => {
      await expect(sendSpecialKeys('test-session', ['InvalidKey'])).rejects.toThrow(
        'Invalid special key: InvalidKey'
      );
      expect(execFile).not.toHaveBeenCalled();
    });

    it('should return immediately for empty array', async () => {
      await sendSpecialKeys('test-session', []);
      expect(execFile).not.toHaveBeenCalled();
    });
  });

  // D4-004: Shell injection prevention tests
  describe('shell injection prevention', () => {
    it('should pass session name as argument array element (not shell-interpreted)', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const malicious = 'test"; rm -rf /; #';
      await hasSession(malicious);

      // The malicious string is passed as a single argument element, not shell-interpreted
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', malicious],
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should pass command with shell metacharacters safely via sendKeys', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      const maliciousCommand = '$(rm -rf /) && echo pwned';
      await sendKeys('test-session', maliciousCommand);

      // The malicious command is passed as a single argument, not interpreted by shell
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-t', 'test-session', maliciousCommand, 'C-m'],
        expect.any(Object),
        expect.any(Function)
      );
    });
  });
});
