/**
 * Tests for sendTextViaBuffer() function
 * Issue #163: Fix multiline message sending via tmux buffer
 * Uses spawn for stdin pipe to avoid shell escaping issues
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'events';
import type { Writable } from 'stream';

// Create mock spawn child process factory
function createMockChildProcess(exitCode = 0) {
  const cp = new EventEmitter() as EventEmitter & {
    stdin: Writable & { writtenData: string };
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };

  const writtenChunks: string[] = [];
  cp.stdin = {
    writtenData: '',
    write(data: string) {
      writtenChunks.push(data);
      cp.stdin.writtenData += data;
      return true;
    },
    end() {
      // Simulate async close -> emit 'close' event on process
      setTimeout(() => cp.emit('close', exitCode), 0);
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  cp.stdout = new EventEmitter();
  cp.stderr = new EventEmitter();
  cp.kill = vi.fn();

  return cp;
}

// Mock child_process
vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockExec = vi.fn((...args: any[]) => {
    const cb = typeof args[1] === 'function' ? args[1] : args[2];
    if (cb) {
      cb(null, { stdout: '', stderr: '' });
    }
    return {};
  });

  const mockSpawn = vi.fn(() => createMockChildProcess(0));

  return { exec: mockExec, spawn: mockSpawn };
});

import { sendTextViaBuffer } from '@/lib/tmux';
import { exec, spawn } from 'child_process';

describe('sendTextViaBuffer() - Issue #163', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset spawn mock to default success behavior
    vi.mocked(spawn).mockImplementation(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      createMockChildProcess(0) as any
    );
  });

  describe('Normal operations', () => {
    it('should send single-line text via buffer with Enter', async () => {
      await sendTextViaBuffer('test-session', 'Hello World');

      // spawn called once for load-buffer
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['load-buffer', '-b', 'cm-test-session', '-'],
        expect.objectContaining({ stdio: ['pipe', 'pipe', 'pipe'] })
      );

      // exec called twice: paste-buffer + send-keys (C-m)
      expect(exec).toHaveBeenCalledTimes(2);

      // Verify paste-buffer call
      const pasteBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(pasteBufferCall).toContain('tmux paste-buffer');
      expect(pasteBufferCall).toContain('-t "test-session"');
      expect(pasteBufferCall).toContain('-dp');

      // Verify Enter key
      const enterCall = vi.mocked(exec).mock.calls[1][0] as string;
      expect(enterCall).toContain('tmux send-keys');
      expect(enterCall).toContain('C-m');

      // Verify text was written to stdin
      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('Hello World');
    });

    it('should send multiline text (50+ lines) via buffer', async () => {
      const lines = Array.from({ length: 55 }, (_, i) => `Line ${i + 1}`);
      const multilineText = lines.join('\n');

      await sendTextViaBuffer('test-session', multilineText);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(2);

      // Verify the full multiline text was written to stdin
      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe(multilineText);
    });

    it('should not send Enter when sendEnter=false', async () => {
      await sendTextViaBuffer('test-session', 'Hello', false);

      // spawn once for load-buffer, exec once for paste-buffer (no C-m)
      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(1);

      const calls = vi.mocked(exec).mock.calls;
      // Verify no C-m send-keys call
      const hasEnterCall = calls.some((call) => {
        const cmd = call[0] as string;
        return cmd.includes('send-keys') && cmd.includes('C-m');
      });
      expect(hasEnterCall).toBe(false);
    });
  });

  describe('Text sent without shell escaping (stdin pipe)', () => {
    it('should send $ character directly without escaping', async () => {
      await sendTextViaBuffer('test-session', 'echo $HOME');

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('echo $HOME');
    });

    it('should send " character directly without escaping', async () => {
      await sendTextViaBuffer('test-session', 'say "hello"');

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('say "hello"');
    });

    it('should send ` character directly without escaping', async () => {
      await sendTextViaBuffer('test-session', 'echo `id`');

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('echo `id`');
    });

    it('should send \\ character directly without escaping', async () => {
      await sendTextViaBuffer('test-session', 'path\\to\\file');

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('path\\to\\file');
    });

    it('should send parentheses and brackets without escaping', async () => {
      await sendTextViaBuffer('test-session', 'func(arg) { arr[0] }');

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('func(arg) { arr[0] }');
    });

    it('should send JSON content without escaping issues', async () => {
      const json = '{"key": "value", "arr": [1, 2], "nested": {"$ref": "#/defs"}}';
      await sendTextViaBuffer('test-session', json);

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe(json);
    });
  });

  describe('Buffer name sanitization (SEC-002)', () => {
    it('should sanitize special characters in session name', async () => {
      await sendTextViaBuffer('session/with:special@chars!', 'test');

      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['load-buffer', '-b', 'cm-session_with_special_chars_', '-'],
        expect.any(Object)
      );
    });
  });

  describe('Error handling', () => {
    it('should cleanup buffer on load-buffer failure', async () => {
      // Make spawn return a process that exits with error
      vi.mocked(spawn).mockImplementation(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMockChildProcess(1) as any
      );

      await expect(sendTextViaBuffer('test-session', 'Hello')).rejects.toThrow();

      // Verify cleanup was attempted via exec delete-buffer
      const calls = vi.mocked(exec).mock.calls;
      const deleteBufferCall = calls.find((call) => {
        const cmd = call[0] as string;
        return cmd.includes('delete-buffer');
      });
      expect(deleteBufferCall).toBeDefined();
    });

    it('should cleanup buffer on paste-buffer failure', async () => {
      let execCallIndex = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(exec).mockImplementation((...args: any[]) => {
        const cb = typeof args[1] === 'function' ? args[1] : args[2];
        execCallIndex++;
        if (execCallIndex === 1) {
          // paste-buffer fails
          if (cb) cb(new Error('paste-buffer failed'), { stdout: '', stderr: '' });
        } else {
          // cleanup succeeds
          if (cb) cb(null, { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      await expect(sendTextViaBuffer('test-session', 'Hello')).rejects.toThrow();

      // Verify cleanup was attempted
      const calls = vi.mocked(exec).mock.calls;
      const deleteBufferCall = calls.find((call) => {
        const cmd = call[0] as string;
        return cmd.includes('delete-buffer');
      });
      expect(deleteBufferCall).toBeDefined();
    });
  });

  describe('Edge cases', () => {
    it('should handle empty string', async () => {
      await sendTextViaBuffer('test-session', '');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(2);

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('');
    });

    it('should handle very long text (10000+ characters)', async () => {
      const longText = 'a'.repeat(10001);

      await sendTextViaBuffer('test-session', longText);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(2);

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe(longText);
    });

    it('should handle text with only special characters', async () => {
      const specialText = '$"\\`$"\\`';

      await sendTextViaBuffer('test-session', specialText);

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(exec).toHaveBeenCalledTimes(2);

      // Text should be passed through as-is (no shell escaping needed)
      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe(specialText);
    });
  });

  describe('NUL byte handling (SEC-004)', () => {
    it('should remove NUL bytes from text (leading/middle/trailing/consecutive/NUL-only)', async () => {
      // Leading NUL
      await sendTextViaBuffer('test-session', '\0Hello');
      let mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('Hello');
      vi.clearAllMocks();
      vi.mocked(spawn).mockImplementation(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMockChildProcess(0) as any
      );

      // Middle NUL
      await sendTextViaBuffer('test-session', 'He\0llo');
      mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('Hello');
      vi.clearAllMocks();
      vi.mocked(spawn).mockImplementation(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMockChildProcess(0) as any
      );

      // Trailing NUL
      await sendTextViaBuffer('test-session', 'Hello\0');
      mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('Hello');
      vi.clearAllMocks();
      vi.mocked(spawn).mockImplementation(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMockChildProcess(0) as any
      );

      // Consecutive NULs
      await sendTextViaBuffer('test-session', 'He\0\0\0llo');
      mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('Hello');
      vi.clearAllMocks();
      vi.mocked(spawn).mockImplementation(() =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        createMockChildProcess(0) as any
      );

      // NUL-only text
      await sendTextViaBuffer('test-session', '\0\0\0');
      mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('');
    });
  });

  describe('Prompt not detected path (IMP-003)', () => {
    it('should work correctly after catch block (prompt not detected)', async () => {
      // This tests that sendTextViaBuffer works correctly regardless of
      // whether it was called after a prompt detection catch block
      await sendTextViaBuffer('test-session', 'message after catch');

      expect(spawn).toHaveBeenCalledTimes(1);
      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['load-buffer', '-b', 'cm-test-session', '-'],
        expect.any(Object)
      );

      const mockProc = vi.mocked(spawn).mock.results[0].value;
      expect(mockProc.stdin.writtenData).toBe('message after catch');

      const pasteBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(pasteBufferCall).toContain('tmux paste-buffer');

      const enterCall = vi.mocked(exec).mock.calls[1][0] as string;
      expect(enterCall).toContain('C-m');
    });
  });
});
