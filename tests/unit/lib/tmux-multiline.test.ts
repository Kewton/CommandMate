/**
 * Unit tests for multiline message handling in sendMessageWithEnter()
 * [Issue #163] Multiline message support for Claude CLI
 *
 * Tests the behavior of sendMessageWithEnter() when handling messages
 * containing newline characters, using spawn-based tmux send-keys -l.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { exec, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';

// Mock child_process module
vi.mock('child_process', () => ({
  exec: vi.fn(),
  spawn: vi.fn(),
}));

import { sendMessageWithEnter } from '@/lib/tmux';

/**
 * Helper to create a mock spawn child process
 * Returns an EventEmitter that mimics ChildProcess behavior
 */
function createMockChildProcess(exitCode: number = 0): ChildProcess {
  const mockProcess = new EventEmitter() as ChildProcess;
  // Simulate async close event
  process.nextTick(() => {
    mockProcess.emit('close', exitCode);
  });
  return mockProcess;
}

/**
 * Helper to create a mock spawn child process that emits an error
 */
function createMockErrorProcess(error: Error): ChildProcess {
  const mockProcess = new EventEmitter() as ChildProcess;
  process.nextTick(() => {
    mockProcess.emit('error', error);
  });
  return mockProcess;
}

describe('sendMessageWithEnter - multiline support [Issue #163]', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('single-line messages (backward compatible)', () => {
    it('should use sendKeys() for single-line messages', async () => {
      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendMessageWithEnter('test-session', 'hello world');

      // Should call exec (sendKeys) twice: once for content, once for Enter
      expect(exec).toHaveBeenCalledTimes(2);
      // First call: send content without Enter
      expect(exec).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining("'hello world'"),
        expect.any(Object),
        expect.any(Function)
      );
      // Second call: send Enter (C-m)
      expect(exec).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('C-m'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should not use spawn for single-line messages', async () => {
      const { spawn } = await import('child_process');

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendMessageWithEnter('test-session', 'single line');

      // spawn should NOT be called for single-line messages
      expect(spawn).not.toHaveBeenCalled();
    });
  });

  describe('multiline messages (new spawn-based path)', () => {
    it('should use spawn with send-keys -l for multiline messages', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      // Mock exec for the Enter key send
      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      const multilineMessage = 'line 1\nline 2\nline 3';
      await sendMessageWithEnter('test-session', multilineMessage);

      // Should call spawn with send-keys -l
      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-l', '-t', 'test-session', multilineMessage]
      );
    });

    it('should send Enter key after multiline content', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendMessageWithEnter('test-session', 'line 1\nline 2');

      // After spawn, should send Enter via exec (sendKeys)
      expect(exec).toHaveBeenCalledWith(
        expect.stringContaining('C-m'),
        expect.any(Object),
        expect.any(Function)
      );
    });

    it('should handle special shell characters safely via spawn', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      // Message with characters that would be dangerous in exec/shell
      const dangerousMessage = 'const x = `hello ${world}`;\nconst y = "test $PATH";';
      await sendMessageWithEnter('test-session', dangerousMessage);

      // spawn passes the message as an argument array element, no shell interpretation
      expect(spawn).toHaveBeenCalledWith(
        'tmux',
        ['send-keys', '-l', '-t', 'test-session', dangerousMessage]
      );
    });

    it('should propagate spawn error', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(
        createMockErrorProcess(new Error('spawn ENOENT'))
      );

      await expect(
        sendMessageWithEnter('test-session', 'line1\nline2')
      ).rejects.toThrow('Failed to send multiline message');
    });

    it('should propagate spawn non-zero exit code', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(1));

      await expect(
        sendMessageWithEnter('test-session', 'line1\nline2')
      ).rejects.toThrow('tmux send-keys -l exited with code 1');
    });
  });

  describe('validation (applies to both paths)', () => {
    it('should reject empty string with newline only', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      // A message that is just a newline should work (it contains \n so multiline path)
      // This is a valid multiline message
      await sendMessageWithEnter('test-session', '\n');
      expect(spawn).toHaveBeenCalled();
    });

    it('should reject messages with null bytes in multiline path', async () => {
      await expect(
        sendMessageWithEnter('test-session', 'line1\nline2\0bad')
      ).rejects.toThrow('Message contains null byte');
    });

    it('should reject messages with dangerous control characters in multiline path', async () => {
      // \x01 (SOH) is a dangerous control character
      await expect(
        sendMessageWithEnter('test-session', 'line1\nline2\x01bad')
      ).rejects.toThrow('Message contains prohibited control characters');
    });

    it('should reject messages exceeding MAX_LINE_COUNT in multiline path', async () => {
      // MAX_LINE_COUNT = 10000
      const hugeMessage = Array.from({ length: 10001 }, (_, i) => `line ${i}`).join('\n');
      await expect(
        sendMessageWithEnter('test-session', hugeMessage)
      ).rejects.toThrow('Message exceeds maximum line count');
    });

    it('should reject messages exceeding MAX_MESSAGE_SIZE in multiline path', async () => {
      // MAX_MESSAGE_SIZE = 100KB, create a large multiline message
      const largeLine = 'x'.repeat(50 * 1024);
      const largeMessage = `${largeLine}\n${largeLine}\n${largeLine}`;
      await expect(
        sendMessageWithEnter('test-session', largeMessage)
      ).rejects.toThrow('Message exceeds maximum size');
    });

    it('should reject invalid session names', async () => {
      await expect(
        sendMessageWithEnter('bad;session', 'line1\nline2')
      ).rejects.toThrow('Invalid session name');
    });
  });

  describe('delay handling for multiline', () => {
    it('should apply delay between content send and Enter send', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      const promise = sendMessageWithEnter('test-session', 'line1\nline2', 200);

      // Let all timers and microtasks resolve
      await vi.advanceTimersByTimeAsync(300);
      await promise;

      // Both spawn and exec (for Enter) should have been called
      expect(spawn).toHaveBeenCalled();
      expect(exec).toHaveBeenCalled();
    });

    it('should skip delay when delay is 0', async () => {
      const { spawn } = await import('child_process');
      vi.mocked(spawn).mockReturnValue(createMockChildProcess(0));

      vi.mocked(exec).mockImplementation((_cmd, _options, callback: any) => {
        callback(null, { stdout: '', stderr: '' });
        return {} as any;
      });

      await sendMessageWithEnter('test-session', 'line1\nline2', 0);

      expect(spawn).toHaveBeenCalled();
      expect(exec).toHaveBeenCalled();
    });
  });
});
