/**
 * Tests for sendTextViaBuffer() function
 * Issue #163: Fix multiline message sending via tmux buffer
 * TDD Approach: Write tests first (Red), then implement (Green)
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock child_process before importing tmux module
vi.mock('child_process', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mockExec = vi.fn((...args: any[]) => {
    const cb = typeof args[1] === 'function' ? args[1] : args[2];
    if (cb) {
      cb(null, { stdout: '', stderr: '' });
    }
    return {};
  });
  return { exec: mockExec };
});

import { sendTextViaBuffer } from '@/lib/tmux';
import { exec } from 'child_process';

describe('sendTextViaBuffer() - Issue #163', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Normal operations', () => {
    it('should send single-line text via buffer with Enter', async () => {
      await sendTextViaBuffer('test-session', 'Hello World');

      // Should call execAsync 3 times: load-buffer, paste-buffer, send-keys (C-m)
      expect(exec).toHaveBeenCalledTimes(3);

      // Verify load-buffer call
      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('tmux load-buffer');
      expect(loadBufferCall).toContain('-b "cm-test-session"');

      // Verify paste-buffer call
      const pasteBufferCall = vi.mocked(exec).mock.calls[1][0] as string;
      expect(pasteBufferCall).toContain('tmux paste-buffer');
      expect(pasteBufferCall).toContain('-t "test-session"');
      expect(pasteBufferCall).toContain('-dp');

      // Verify Enter key
      const enterCall = vi.mocked(exec).mock.calls[2][0] as string;
      expect(enterCall).toContain('tmux send-keys');
      expect(enterCall).toContain('C-m');
    });

    it('should send multiline text (50+ lines) via buffer', async () => {
      const lines = Array.from({ length: 55 }, (_, i) => `Line ${i + 1}`);
      const multilineText = lines.join('\n');

      await sendTextViaBuffer('test-session', multilineText);

      expect(exec).toHaveBeenCalledTimes(3);

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('tmux load-buffer');
    });

    it('should not send Enter when sendEnter=false', async () => {
      await sendTextViaBuffer('test-session', 'Hello', false);

      // Should call execAsync 2 times: load-buffer, paste-buffer (no C-m)
      expect(exec).toHaveBeenCalledTimes(2);

      const calls = vi.mocked(exec).mock.calls;
      // Verify no C-m send-keys call
      const hasEnterCall = calls.some((call) => {
        const cmd = call[0] as string;
        return cmd.includes('send-keys') && cmd.includes('C-m');
      });
      expect(hasEnterCall).toBe(false);
    });
  });

  describe('Escape processing (SEC-001)', () => {
    it('should escape $ character (variable expansion prevention)', async () => {
      await sendTextViaBuffer('test-session', 'echo $HOME');

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('\\$');
    });

    it('should escape " character', async () => {
      await sendTextViaBuffer('test-session', 'say "hello"');

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('\\"');
    });

    it('should escape ` character (command substitution prevention)', async () => {
      await sendTextViaBuffer('test-session', 'echo `id`');

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('\\`');
    });

    it('should escape \\ character (backslash first to prevent double-escape)', async () => {
      await sendTextViaBuffer('test-session', 'path\\to\\file');

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      // Backslash should be escaped: \ -> \\\\
      expect(loadBufferCall).toContain('\\\\');
    });
  });

  describe('Buffer name sanitization (SEC-002)', () => {
    it('should sanitize special characters in session name', async () => {
      await sendTextViaBuffer('session/with:special@chars!', 'test');

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      // Special chars replaced with _, prefix cm-
      expect(loadBufferCall).toContain('-b "cm-session_with_special_chars_"');
    });
  });

  describe('Error handling', () => {
    it('should cleanup buffer on load-buffer failure', async () => {
      // Make load-buffer fail
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(exec).mockImplementationOnce((...args: any[]) => {
        const cb = typeof args[1] === 'function' ? args[1] : args[2];
        if (cb) {
          cb(new Error('load-buffer failed'), { stdout: '', stderr: '' });
        }
        return {} as ReturnType<typeof exec>;
      });

      // Make delete-buffer succeed (cleanup)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(exec).mockImplementationOnce((...args: any[]) => {
        const cb = typeof args[1] === 'function' ? args[1] : args[2];
        if (cb) {
          cb(null, { stdout: '', stderr: '' });
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

    it('should cleanup buffer on paste-buffer failure', async () => {
      let callIndex = 0;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      vi.mocked(exec).mockImplementation((...args: any[]) => {
        const cb = typeof args[1] === 'function' ? args[1] : args[2];
        callIndex++;
        if (callIndex === 1) {
          // load-buffer succeeds
          if (cb) cb(null, { stdout: '', stderr: '' });
        } else if (callIndex === 2) {
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

      expect(exec).toHaveBeenCalledTimes(3);

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('tmux load-buffer');
    });

    it('should handle very long text (10000+ characters)', async () => {
      const longText = 'a'.repeat(10001);

      await sendTextViaBuffer('test-session', longText);

      expect(exec).toHaveBeenCalledTimes(3);
    });

    it('should handle text with only special characters', async () => {
      const specialText = '$"\\`$"\\`';

      await sendTextViaBuffer('test-session', specialText);

      expect(exec).toHaveBeenCalledTimes(3);

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      // All special chars should be escaped
      expect(loadBufferCall).not.toContain('$(');
      expect(loadBufferCall).toContain('\\$');
    });
  });

  describe('NUL byte handling (SEC-004)', () => {
    it('should remove NUL bytes from text (leading/middle/trailing/consecutive/NUL-only)', async () => {
      // Leading NUL
      await sendTextViaBuffer('test-session', '\0Hello');
      let loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).not.toContain('\0');
      vi.clearAllMocks();

      // Middle NUL
      await sendTextViaBuffer('test-session', 'He\0llo');
      loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).not.toContain('\0');
      vi.clearAllMocks();

      // Trailing NUL
      await sendTextViaBuffer('test-session', 'Hello\0');
      loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).not.toContain('\0');
      vi.clearAllMocks();

      // Consecutive NULs
      await sendTextViaBuffer('test-session', 'He\0\0\0llo');
      loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).not.toContain('\0');
      vi.clearAllMocks();

      // NUL-only text
      await sendTextViaBuffer('test-session', '\0\0\0');
      loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).not.toContain('\0');
    });
  });

  describe('Prompt not detected path (IMP-003)', () => {
    it('should work correctly after catch block (prompt not detected)', async () => {
      // This tests that sendTextViaBuffer works correctly regardless of
      // whether it was called after a prompt detection catch block
      await sendTextViaBuffer('test-session', 'message after catch');

      expect(exec).toHaveBeenCalledTimes(3);

      const loadBufferCall = vi.mocked(exec).mock.calls[0][0] as string;
      expect(loadBufferCall).toContain('tmux load-buffer');
      expect(loadBufferCall).toContain('message after catch');

      const pasteBufferCall = vi.mocked(exec).mock.calls[1][0] as string;
      expect(pasteBufferCall).toContain('tmux paste-buffer');

      const enterCall = vi.mocked(exec).mock.calls[2][0] as string;
      expect(enterCall).toContain('C-m');
    });
  });
});
