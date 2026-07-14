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
  exactTarget,
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
        ['has-session', '-t', '=test-session:'],
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

      // Issue #1163: default pane height is now TUI_PANE_HEIGHT (1000 rows)
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd', '-x', '200', '-y', '1000'],
        { timeout: 5000 },
        expect.any(Function)
      );
      // Issue #1163: pin window-size manual (per session) so `window-size latest`
      // never shrinks the pane when a small client attaches.
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-window-option', '-t', '=test-session:', 'window-size', 'manual'],
        { timeout: 5000 },
        expect.any(Function)
      );
      // Issue #1163: explicit resize-window locks in the intended geometry
      // (the -y on new-session does not survive window-size latest on its own).
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['resize-window', '-t', '=test-session:', '-x', '200', '-y', '1000'],
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-t', '=test-session:', 'history-limit', '50000'],
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

      // Issue #1163: default pane height is now TUI_PANE_HEIGHT (1000 rows)
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd', '-x', '200', '-y', '1000'],
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-t', '=test-session:', 'history-limit', '100000'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should create session with window size options', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
        windowWidth: 200,
        windowHeight: 50,
      });

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd', '-x', '200', '-y', '50'],
        { timeout: 5000 },
        expect.any(Function)
      );
      // Issue #1163: resize-window honors the explicit windowWidth/windowHeight too
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['resize-window', '-t', '=test-session:', '-x', '200', '-y', '50'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should use default window size (200x1000) with legacy signature', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await createSession('test-session', '/path/to/cwd');

      // Issue #1163: default height raised to TUI_PANE_HEIGHT (1000 rows)
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd', '-x', '200', '-y', '1000'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('should use default window size with options object (no size specified)', async () => {
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const callback = args[args.length - 1] as (err: Error | null, result: { stdout: string; stderr: string }) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
      });

      // Issue #1163: default height raised to TUI_PANE_HEIGHT (1000 rows)
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['new-session', '-d', '-s', 'test-session', '-c', '/path/to/cwd', '-x', '200', '-y', '1000'],
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

  // Issue #1163: pane-height pinning so `window-size latest` cannot shrink the
  // capturable rows of an alternate-screen TUI when a small client attaches.
  describe('createSession window-size pinning (Issue #1163)', () => {
    /** Record the tmux subcommand of each execFile call in order. */
    function installOrderRecordingMock(): string[] {
      const subcommands: string[] = [];
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        subcommands.push(cmdArgs[0]);
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void;
        callback(null, { stdout: '', stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });
      return subcommands;
    }

    it('sets window-size manual then resize-window AFTER new-session (order matters)', async () => {
      const subcommands = installOrderRecordingMock();

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
      });

      const newSessionIdx = subcommands.indexOf('new-session');
      const setWinOptIdx = subcommands.indexOf('set-window-option');
      const resizeIdx = subcommands.indexOf('resize-window');

      expect(newSessionIdx).toBeGreaterThanOrEqual(0);
      expect(setWinOptIdx).toBeGreaterThan(newSessionIdx);
      expect(resizeIdx).toBeGreaterThan(setWinOptIdx);
    });

    it('targets the session exactly (=name:) for window-size manual and resize', async () => {
      installOrderRecordingMock();

      await createSession({
        sessionName: 'mcbd-claude-wt',
        workingDirectory: '/path/to/cwd',
      });

      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-window-option', '-t', '=mcbd-claude-wt:', 'window-size', 'manual'],
        { timeout: 5000 },
        expect.any(Function)
      );
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['resize-window', '-t', '=mcbd-claude-wt:', '-x', '200', '-y', '1000'],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('never touches the GLOBAL window-size option (-g)', async () => {
      installOrderRecordingMock();

      await createSession({
        sessionName: 'test-session',
        workingDirectory: '/path/to/cwd',
      });

      // No call may pass -g together with window-size (would leak to all sessions).
      for (const call of vi.mocked(execFile).mock.calls) {
        const cmdArgs = call[1] as string[];
        if (cmdArgs.includes('window-size')) {
          expect(cmdArgs).not.toContain('-g');
        }
      }
    });

    it('treats window-size/resize failure as non-fatal (session still created)', async () => {
      // new-session + set-option succeed; the window-size/resize calls fail.
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const subcommand = cmdArgs[0];
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void;
        if (subcommand === 'set-window-option' || subcommand === 'resize-window') {
          callback(new Error('resize not supported'), { stdout: '', stderr: '' });
        } else {
          callback(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof execFile>;
      });

      await expect(
        createSession({ sessionName: 'test-session', workingDirectory: '/path/to/cwd' })
      ).resolves.toBeUndefined();

      // history-limit is still applied after the swallowed resize failure.
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['set-option', '-t', '=test-session:', 'history-limit', '50000'],
        { timeout: 5000 },
        expect.any(Function)
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
        ['send-keys', '-t', '=test-session:', 'echo hello', 'C-m'],
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
        ['send-keys', '-t', '=test-session:', 'echo hello'],
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
        ['send-keys', '-t', '=test-session:', "echo 'hello'", 'C-m'],
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
        ['capture-pane', '-t', '=test-session:', '-p', '-e', '-S', '-1000', '-E', '-'],
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
        ['capture-pane', '-t', '=test-session:', '-p', '-e', '-S', '-500', '-E', '-'],
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
        ['capture-pane', '-t', '=test-session:', '-p', '-e', '-S', '-10000', '-E', '-1'],
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
        ['kill-session', '-t', '=test-session:'],
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

      // Should call has-session, new-session, set-window-option (window-size manual),
      // resize-window, and set-option (Issue #1163 adds the window-size + resize calls)
      expect(execFile).toHaveBeenCalledTimes(5);
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
        ['has-session', '-t', '=test-session:'],
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
        ['send-keys', '-t', '=test-session:', 'Escape'],
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
        ['send-keys', '-t', '=test-session:', 'C-c'],
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
        ['send-keys', '-t', '=test-session:', 'C-d'],
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
        ['send-keys', '-t', '=test-session:', 'Down'],
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

      // The malicious string is passed as a single argument element, not shell-interpreted.
      // Issue #1156: the target is exact-match prefixed (`=`) but still a single arg.
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', `=${malicious}:`],
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
        ['send-keys', '-t', '=test-session:', maliciousCommand, 'C-m'],
        expect.any(Object),
        expect.any(Function)
      );
    });
  });

  // Issue #1156: prefix-collision session leakage prevention
  describe('exactTarget helper (Issue #1156)', () => {
    it('should prefix the session name with = for exact matching', () => {
      expect(exactTarget('mcbd-claude-wt')).toBe('=mcbd-claude-wt:');
    });

    it('should produce distinct exact-match targets for primary and -2', () => {
      // Both targets are exact-match forms; tmux will not resolve one from the other.
      // (The behavioral guarantee is exercised by the leakage tests below.)
      expect(exactTarget('mcbd-claude-wt')).toBe('=mcbd-claude-wt:');
      expect(exactTarget('mcbd-claude-wt-2')).toBe('=mcbd-claude-wt-2:');
      expect(exactTarget('mcbd-claude-wt')).not.toBe(exactTarget('mcbd-claude-wt-2'));
    });
  });

  // Issue #1156: with a prefix-colliding pair (X and X-2), operations on the
  // un-started primary X must NOT leak to the running X-2. We drive the real
  // tmux functions through a mock that faithfully emulates tmux target
  // resolution: a bare `-t <name>` falls back to prefix matching, while a
  // `-t =<name>` target requires an exact session-name match.
  describe('prefix collision session leakage (Issue #1156)', () => {
    const PRIMARY = 'mcbd-claude-mycodebranchdesk-develop';
    const SECOND = 'mcbd-claude-mycodebranchdesk-develop-2';

    /**
     * Resolve a tmux `-t` target against the set of live sessions, mirroring
     * tmux semantics:
     *   - `=name:` is exact-only and valid for BOTH session and window/pane
     *     commands (the form this fix ships).
     *   - `=name` (no trailing `:`) is exact-only for session commands but is
     *     rejected by window/pane commands (capture-pane/send-keys) as an invalid
     *     pane spec — the regression that shipped from the initial #1156 fix.
     *   - a bare `name` matches exactly or, failing that, by prefix (the original
     *     #1156 bug this fix closes).
     */
    function resolveTarget(
      target: string,
      liveSessions: Map<string, string>,
      subcommand?: string
    ): string | null {
      if (target.startsWith('=')) {
        const paneCommand = subcommand === 'capture-pane' || subcommand === 'send-keys';
        const hasColon = target.endsWith(':');
        // Real tmux rejects `=name` (no `:`) for pane/window commands.
        if (paneCommand && !hasColon) return null;
        const exact = target.slice(1).replace(/:$/, '');
        return liveSessions.has(exact) ? exact : null;
      }
      if (liveSessions.has(target)) return target;
      for (const name of liveSessions.keys()) {
        if (name.startsWith(target)) return name;
      }
      return null;
    }

    /**
     * Build an execFile mock backed by `liveSessions` (name -> pane content).
     * Records every resolved target so tests can assert what a call touched.
     */
    function installTmuxMock(liveSessions: Map<string, string>): { resolvedTargets: Array<string | null> } {
      const resolvedTargets: Array<string | null> = [];
      vi.mocked(execFile).mockImplementation((...args: unknown[]) => {
        const cmdArgs = args[1] as string[];
        const callback = args[args.length - 1] as (
          err: Error | null,
          result: { stdout: string; stderr: string }
        ) => void;
        const subcommand = cmdArgs[0];
        const tIdx = cmdArgs.indexOf('-t');
        if (tIdx === -1) {
          callback(null, { stdout: '', stderr: '' });
          return {} as ReturnType<typeof execFile>;
        }
        const target = cmdArgs[tIdx + 1];
        const resolved = resolveTarget(target, liveSessions, subcommand);
        resolvedTargets.push(resolved);
        if (!resolved) {
          callback(new Error(`can't find session: ${target.replace(/^=/, '').replace(/:$/, '')}`), {
            stdout: '',
            stderr: '',
          });
          return {} as ReturnType<typeof execFile>;
        }
        const stdout = subcommand === 'capture-pane' ? (liveSessions.get(resolved) ?? '') : '';
        callback(null, { stdout, stderr: '' });
        return {} as ReturnType<typeof execFile>;
      });
      return { resolvedTargets };
    }

    it('has-session on the un-started primary returns false (does not match -2)', async () => {
      const { resolvedTargets } = installTmuxMock(new Map([[SECOND, 'second-content']]));

      const result = await hasSession(PRIMARY);

      expect(result).toBe(false);
      expect(resolvedTargets).toEqual([null]);
      expect(execFile).toHaveBeenCalledWith(
        'tmux',
        ['has-session', '-t', `=${PRIMARY}:`],
        { timeout: 5000 },
        expect.any(Function)
      );
    });

    it('capture-pane on the un-started primary does not return -2 content', async () => {
      installTmuxMock(new Map([[SECOND, 'SECRET-OUTPUT-OF-INSTANCE-2']]));

      await expect(capturePane(PRIMARY)).rejects.toThrow('Failed to capture pane');
    });

    it('send-keys on the un-started primary does not deliver to -2', async () => {
      const { resolvedTargets } = installTmuxMock(new Map([[SECOND, 'second-content']]));

      await expect(sendKeys(PRIMARY, 'hello')).rejects.toThrow('Failed to send keys');
      // Never resolved to the -2 session
      expect(resolvedTargets).toEqual([null]);
    });

    it('kill-session on the un-started primary does not kill -2', async () => {
      const live = new Map([[SECOND, 'second-content']]);
      installTmuxMock(live);

      const killed = await killSession(PRIMARY);

      expect(killed).toBe(false);
      // The -2 session is untouched (still resolvable on its own exact target)
      expect(resolveTargetHelper(`=${SECOND}:`, live)).toBe(SECOND);
    });

    // Regression guard for the normal case: when the primary IS running, all
    // operations still resolve to it (the = prefix does not break exact matches).
    it('operations still work when the primary session exists', async () => {
      installTmuxMock(new Map([[PRIMARY, 'primary-content'], [SECOND, 'second-content']]));

      expect(await hasSession(PRIMARY)).toBe(true);
      expect(await capturePane(PRIMARY)).toBe('primary-content');
      await expect(sendKeys(PRIMARY, 'hello')).resolves.not.toThrow();
      expect(await killSession(PRIMARY)).toBe(true);
    });

    // Local mirror of resolveTarget for post-hoc assertions (kept in scope).
    function resolveTargetHelper(target: string, liveSessions: Map<string, string>): string | null {
      return resolveTarget(target, liveSessions);
    }
  });
});
