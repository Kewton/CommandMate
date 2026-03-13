/**
 * Unit tests for pasted-text-helper module
 * Issue #212: Pasted text detection + Enter resend helper
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock tmux module
vi.mock('@/lib/tmux/tmux', () => ({
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
}));

// Mock logger module (SF-S2-002: logger is internally generated)
// Use vi.hoisted to ensure mock variables are available when vi.mock is hoisted
const { mockWarn, mockLoggerInstance } = vi.hoisted(() => {
  const mockWarn = vi.fn();
  const mockLoggerInstance = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: mockWarn,
    error: vi.fn(),
    withContext: vi.fn().mockReturnThis(),
  };
  return { mockWarn, mockLoggerInstance };
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLoggerInstance),
}));

import { detectAndResendIfPastedText } from '@/lib/pasted-text-helper';
import { capturePane, sendKeys } from '@/lib/tmux/tmux';

const TEST_SESSION_NAME = 'mcbd-claude-test-worktree';

describe('detectAndResendIfPastedText() (Issue #212)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // Test 1: No Pasted text detected (normal flow)
  it('should not send extra Enter when no Pasted text detected', async () => {
    vi.mocked(capturePane).mockResolvedValue('Normal output\n> ');

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    // Advance past the first detection delay (500ms)
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // capturePane called once for detection
    expect(capturePane).toHaveBeenCalledTimes(1);
    expect(capturePane).toHaveBeenCalledWith(TEST_SESSION_NAME, { startLine: -10 });
    // sendKeys should NOT be called (no Enter resend needed)
    expect(sendKeys).not.toHaveBeenCalled();
  });

  // Test 2: Pasted text detected, Enter resend resolves it
  it('should send extra Enter when Pasted text detected', async () => {
    vi.mocked(capturePane)
      .mockResolvedValueOnce('[Pasted text #1 +46 lines]\n') // 1st check: detected
      .mockResolvedValueOnce('Normal output\n> '); // 2nd check: resolved

    vi.mocked(sendKeys).mockResolvedValue();

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    // Advance past first delay (500ms) - detection occurs
    await vi.advanceTimersByTimeAsync(500);
    // Advance past second delay (500ms) - re-check after Enter resend
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // sendKeys called once for Enter resend
    expect(sendKeys).toHaveBeenCalledTimes(1);
    expect(sendKeys).toHaveBeenCalledWith(TEST_SESSION_NAME, '', true);
    // capturePane called twice (detect, then re-check)
    expect(capturePane).toHaveBeenCalledTimes(2);
  });

  // Test 3: Max retries reached - warning log
  it('should log warning with structured logger after max retries', async () => {
    // capturePane always returns Pasted text
    vi.mocked(capturePane).mockResolvedValue('[Pasted text #1 +46 lines]\n');
    vi.mocked(sendKeys).mockResolvedValue();

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    // Advance through all 3 retries (3 x 500ms)
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // sendKeys called 3 times (once per retry)
    expect(sendKeys).toHaveBeenCalledTimes(3);
    // Warning logged on max retries
    expect(mockWarn).toHaveBeenCalledWith(
      'Pasted text detection: max retries reached',
      expect.objectContaining({
        sessionName: TEST_SESSION_NAME,
        maxRetries: 3,
        finalAttempt: 2,
      })
    );
  });

  // Test 4: No error thrown after max retries
  it('should not throw error after max retries', async () => {
    vi.mocked(capturePane).mockResolvedValue('[Pasted text #1 +46 lines]\n');
    vi.mocked(sendKeys).mockResolvedValue();

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    await vi.advanceTimersByTimeAsync(1500); // 3 x 500ms
    // Should resolve without throwing
    await expect(promise).resolves.toBeUndefined();
  });

  // Test 5: capturePane failure propagation
  it('should propagate error when capturePane fails', async () => {
    vi.mocked(capturePane).mockRejectedValue(new Error('tmux error'));

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    // Attach rejection handler before advancing timers to prevent unhandled rejection
    const assertion = expect(promise).rejects.toThrow('tmux error');
    await vi.advanceTimersByTimeAsync(500);
    await assertion;
  });

  // Test 6: ANSI escape codes in capturePane output
  it('should strip ANSI codes before pattern matching', async () => {
    // Pasted text with ANSI escape codes
    vi.mocked(capturePane).mockResolvedValueOnce(
      '\x1b[31m[Pasted text #1 +10 lines]\x1b[0m\n'
    ).mockResolvedValueOnce('Normal output\n> ');
    vi.mocked(sendKeys).mockResolvedValue();

    const promise = detectAndResendIfPastedText(TEST_SESSION_NAME);
    await vi.advanceTimersByTimeAsync(500);
    await vi.advanceTimersByTimeAsync(500);
    await promise;

    // Should detect through ANSI codes and send Enter
    expect(sendKeys).toHaveBeenCalledTimes(1);
  });
});
