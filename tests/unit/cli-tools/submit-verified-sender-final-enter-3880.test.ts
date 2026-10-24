/**
 * Issue #3880 (H-1): the last recovery Enter is read back before a verdict.
 *
 * The read-back loop resent Enter on every pending read — the last one included
 * — and threw straight after that last Enter without reading the pane again. A
 * message that only the last Enter submitted was reported "could not be
 * confirmed": a sent message as exit 99 (`submit-unconfirmed`).
 *
 * The three controls the Issue asks for, at `verifyAttempts: 3`:
 *   - submitted on the first read  -> resolves, one Enter (unchanged);
 *   - submitted only after the last recovery Enter -> resolves (threw before);
 *   - pending to the end -> throws `submit-unconfirmed`, with every Enter read
 *     back and no Enter after the final read (no Enter goes out unread).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn().mockResolvedValue(undefined),
  capturePane: vi.fn().mockResolvedValue(''),
  clearInputLine: vi.fn().mockResolvedValue(undefined),
  clearComposerLine: vi.fn().mockResolvedValue(undefined),
  exactTarget: (name: string) => `=${name}:`,
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('child_process', () => ({ execFile: vi.fn() }));

const loggerSpies = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({ ...loggerSpies, withContext: () => loggerSpies }),
}));

import { sendMessageWithSubmitVerification } from '@/lib/cli-tools/submit-verified-sender';
import { classifySendFailure } from '@/lib/session/send-attempt-state';
import { sendSpecialKeys, capturePane, clearInputLine } from '@/lib/tmux/tmux';

const SESSION = 'mcbd-claude-final-enter';
const MESSAGE = 'hello final enter';
const PENDING = `❯ ${MESSAGE}`;
const SUBMITTED = '❯ ';

const enterCount = (): number =>
  vi.mocked(sendSpecialKeys).mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'Enter').length;

/** The sender's own read-backs (`{ startLine }`); the pre-send clear reads with a number. */
const verifyReads = (): number =>
  vi.mocked(capturePane).mock.calls.filter((c) => typeof c[1] !== 'number').length;

/** Read-backs after Enter return `frames[i]` (the last one repeats). */
function scriptReadBacks(frames: string[]): void {
  let index = 0;
  vi.mocked(capturePane).mockImplementation((async (_session: string, arg?: unknown) => {
    if (typeof arg === 'number') return SUBMITTED;
    return frames[Math.min(index++, frames.length - 1)];
  }) as never);
}

async function send(): Promise<void> {
  const p = sendMessageWithSubmitVerification({
    sessionName: SESSION,
    message: MESSAGE,
    cliToolId: 'claude',
    verifyAttempts: 3,
  });
  const settled = p.then(() => undefined, (error: unknown) => { throw error; });
  settled.catch(() => undefined);
  await vi.runAllTimersAsync();
  return settled;
}

describe('Issue #3880 H-1: the last recovery Enter is read back', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(sendSpecialKeys).mockResolvedValue(undefined);
    vi.mocked(clearInputLine).mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('submitted on the first read: resolves after one Enter and one read (unchanged)', async () => {
    scriptReadBacks([SUBMITTED]);

    await expect(send()).resolves.toBeUndefined();

    expect(enterCount()).toBe(1);
    expect(verifyReads()).toBe(1);
  });

  it('submitted only by the last recovery Enter: resolves instead of "could not be confirmed"', async () => {
    // Initial Enter + 3 recovery Enters; only the read after the 3rd shows it left.
    scriptReadBacks([PENDING, PENDING, PENDING, SUBMITTED]);

    await expect(send()).resolves.toBeUndefined();

    expect(enterCount()).toBe(1 + 3);
    expect(verifyReads()).toBe(4);
    expect(loggerSpies.error).not.toHaveBeenCalledWith('submit-verification-failed', expect.anything());
  });

  it('pending to the end: throws submit-unconfirmed, every Enter read back, none after the last read', async () => {
    scriptReadBacks([PENDING]);

    const error = await send().then(
      () => null,
      (e: unknown) => e
    );

    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/could not be confirmed/i);
    // The Enter budget is unchanged (initial + verifyAttempts) …
    expect(enterCount()).toBe(1 + 3);
    // … and each of those Enters is followed by a read.
    expect(verifyReads()).toBe(enterCount());
    // Still "may have been submitted", never "not sent".
    expect(classifySendFailure(new Error(`Failed to send message to Claude: ${(error as Error).message}`))).toEqual({
      state: 'indeterminate',
      reason: 'submit-unconfirmed',
    });
  });

  it('replaced on the read after the last Enter: clears the line and throws, with no further Enter', async () => {
    scriptReadBacks([PENDING, PENDING, PENDING, '❯ /statusline']);

    await expect(send()).rejects.toThrow(/replaced by a TUI autocompletion/i);

    expect(enterCount()).toBe(1 + 3);
    expect(clearInputLine).toHaveBeenCalledWith(SESSION);
  });
});
