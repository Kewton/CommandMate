/**
 * Unit tests for tmux session management
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec } from 'child_process';
import { promisify } from 'util';
import {
  isTmuxAvailable,
  hasSession,
  listSessions,
  createSession,
  sendKeys,
  capturePane,
  killSession,
  ensureSession,
} from '@/lib/tmux';

// Mock child_process exec
vi.mock('child_process', () => ({
  exec: vi.fn(),
}));

const execAsync = promisify(exec);

describe('tmux library', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('isTmuxAvailable', () => {
    it('should return true when tmux is available', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: 'tmux 3.3a', stderr: '' });
        return {} as any;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(true);
    });

    it('should return false when tmux is not available', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('command not found'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(false);
    });

    it('should handle timeout', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        setTimeout(() => {
          callback(new Error('timeout'), { stdout: '', stderr: '' });
        }, 100);
        return {} as any;
      });

      const result = await isTmuxAvailable();
      expect(result).toBe(false);
    });
  });

  describe('hasSession', () => {
    it('should return true when session exists', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await hasSession('test-session');
      expect(result).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        'tmux has-session -t "test-session"',
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('no sessions'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await hasSession('test-session');
      expect(result).toBe(false);
    });
  });

  describe('listSessions', () => {
    it('should list all tmux sessions', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, {
          stdout: 'session1|2|1\nsession2|1|0\n',
          stderr: '',
        });
        return {} as any;
      });

      const result = await listSessions();

      expect(result).toEqual([
        { name: 'session1', windows: 2, attached: true },
        { name: 'session2', windows: 1, attached: false },
      ]);
    });

    it('should return empty array when no sessions exist', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('no sessions'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await listSessions();
      expect(result).toEqual([]);
    });

    it('should handle empty stdout', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await listSessions();
      expect(result).toEqual([]);
    });
  });

  describe('createSession', () => {
    it('should create session with legacy signature', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await createSession('test-session', '/path/to/cwd');

      expect(exec).toHaveBeenCalledWith(
        'tmux new-session -d -s "test-session" -c "/path/to/cwd"',
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(exec).toHaveBeenCalledWith(
        'tmux set-option -t "test-session" history-limit 50000',
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should create session with options object', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
        historyLimit: 100000,
      });

      expect(exec).toHaveBeenCalledWith(
        'tmux new-session -d -s "test-session" -c "/path/to/cwd"',
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(exec).toHaveBeenCalledWith(
        'tmux set-option -t "test-session" history-limit 100000',
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('failed to create'), { stdout: '', stderr: '' });
        return {} as any;
      });

      await expect(createSession('test-session', '/path/to/cwd')).rejects.toThrow(
        'Failed to create tmux session'
      );
    });
  });

  describe('sendKeys', () => {
    it('should send keys with Enter', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendKeys('test-session', 'echo hello');

      expect(exec).toHaveBeenCalledWith(
        `tmux send-keys -t "test-session" 'echo hello' C-m`,
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should send keys without Enter', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendKeys('test-session', 'echo hello', false);

      expect(exec).toHaveBeenCalledWith(
        `tmux send-keys -t "test-session" 'echo hello'`,
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should escape single quotes', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendKeys('test-session', "echo 'hello'");

      expect(exec).toHaveBeenCalledWith(
        String.raw`tmux send-keys -t "test-session" 'echo '\''hello'\''' C-m`,
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('session not found'), { stdout: '', stderr: '' });
        return {} as any;
      });

      await expect(sendKeys('test-session', 'echo hello')).rejects.toThrow(
        'Failed to send keys to tmux session'
      );
    });
  });

  describe('capturePane', () => {
    it('should capture with default lines (legacy)', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: 'output', stderr: '' });
        return {} as any;
      });

      const result = await capturePane('test-session');

      expect(result).toBe('output');
      expect(exec).toHaveBeenCalledWith(
        'tmux capture-pane -t "test-session" -p -e -S -1000 -E -',
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should capture with specified lines (legacy)', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: 'output', stderr: '' });
        return {} as any;
      });

      const result = await capturePane('test-session', 500);

      expect(result).toBe('output');
      expect(exec).toHaveBeenCalledWith(
        'tmux capture-pane -t "test-session" -p -e -S -500 -E -',
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should capture with options object', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: 'output', stderr: '' });
        return {} as any;
      });

      const result = await capturePane('test-session', {
        startLine: -10000,
        endLine: -1,
      });

      expect(result).toBe('output');
      expect(exec).toHaveBeenCalledWith(
        'tmux capture-pane -t "test-session" -p -e -S -10000 -E -1',
        { timeout: 5000, maxBuffer: 10 * 1024 * 1024 },
        expect.any(Function)
      );
    });

    it('should throw error on failure', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('session not found'), { stdout: '', stderr: '' });
        return {} as any;
      });

      await expect(capturePane('test-session')).rejects.toThrow('Failed to capture pane');
    });
  });

  describe('killSession', () => {
    it('should kill session and return true', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await killSession('test-session');

      expect(result).toBe(true);
      expect(exec).toHaveBeenCalledWith(
        'tmux kill-session -t "test-session"',
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should return false when session does not exist', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error("can't find session"), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await killSession('test-session');
      expect(result).toBe(false);
    });

    it('should return false when no server running', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('no server running'), { stdout: '', stderr: '' });
        return {} as any;
      });

      const result = await killSession('test-session');
      expect(result).toBe(false);
    });

    it('should throw on unexpected errors', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callback(new Error('unexpected error'), { stdout: '', stderr: '' });
        return {} as any;
      });

      await expect(killSession('test-session')).rejects.toThrow(
        'Failed to kill tmux session'
      );
    });
  });

  describe('ensureSession', () => {
    it('should create session if it does not exist', async () => {
      let callCount = 0;
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        callCount++;
        if (callCount === 1) {
          // has-session fails
          callback(new Error('no session'), { stdout: '', stderr: '' });
        } else {
          // new-session and set-option succeed
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as any;
      });

      await ensureSession('test-session', '/path/to/cwd');

      // Should call has-session, new-session, and set-option
      expect(exec).toHaveBeenCalledTimes(3);
    });

    it('should not create session if it already exists', async () => {
      vi.mocked(exec).mockImplementation((cmd, options, callback: any) => {
        // has-session succeeds
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await ensureSession('test-session', '/path/to/cwd');

      // Should only call has-session
      expect(exec).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledWith(
        'tmux has-session -t "test-session"',
        { timeout: 5000 },
        expect.any(Function)
      );
    });
  });
});
