/**
 * Issue #1894: `OpenCodeTool.interrupt()` presses Escape twice.
 *
 * `BaseCLITool.interrupt()` sends one Escape, and `OpenCodeTool` used to inherit
 * it with a comment claiming opencode "supports Escape for interruption
 * ('esc interrupt' display)" [D2-008]. Measured on opencode 1.18.21 (private
 * tmux socket, 80x200), that has never been true: one Escape only re-labels the
 * footer `esc interrupt` -> `esc again to interrupt`, and the turn runs to a
 * natural completion — `· 11.3s`, `· 16.3s`, `· 19.0s` over three runs, three
 * completions, zero aborts. Only a SECOND Escape inside that label's five-second
 * lifetime ends the turn, leaving `▣  Build · GPT-5.6 Luna · interrupted`.
 *
 * ## What this file pins, and what it cannot
 *
 * The sequence and its timing, against a mocked tmux: two Escapes, to the right
 * session, with {@link OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS} between them
 * and nothing else in between. The timing is driven with fake timers so the
 * delay is read out of the observable behaviour rather than out of the constant
 * — widening it to 3 s or collapsing it to 0 both turn this file red.
 *
 * What a mock cannot show is that two Escapes abort anything. That was measured
 * live, twice: from a shell harness with the two presses 594 ms apart, and by
 * calling THIS method against a live opencode session with `TMUX` pointed at a
 * private socket (317 ms end to end, generation stopped mid-sentence). The
 * frames are checked in under `tests/unit/lib/detection/fixtures/opencode-live-1894/`
 * and read by `tests/unit/detection-opencode-interrupt-1894.test.ts`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn(),
  createSession: vi.fn(),
  capturePane: vi.fn(),
  sendKeys: vi.fn(),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  sendSpecialKeys: vi.fn(),
  killSession: vi.fn(),
  exactTarget: vi.fn((name: string) => `=${name}:`),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/tmux/tmux-capture-cache', () => ({
  invalidateCache: vi.fn(),
}));

vi.mock('@/lib/cli-tools/opencode-config', () => ({
  ensureOpencodeConfig: vi.fn(),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
}));

// The event pipeline is stubbed so importing the tool binds no port and opens
// no socket. Same shape as `opencode.test.ts`.
vi.mock('@/lib/hooks/sources/opencode/runtime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/hooks/sources/opencode/runtime')>();
  return {
    ...actual,
    reserveOpencodeServerPort: vi.fn().mockResolvedValue(null),
    attachOpencodeEventStream: vi.fn().mockResolvedValue(false),
    resumeOpencodeEventStream: vi.fn().mockResolvedValue(false),
    releaseOpencodeEventStream: vi.fn().mockResolvedValue(undefined),
  };
});

import { BaseCLITool } from '@/lib/cli-tools/base';
import { OpenCodeTool } from '@/lib/cli-tools/opencode';
import { OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS } from '@/config/cli-tool-timing-config';
import { sendSpecialKey } from '@/lib/tmux/tmux';
import { invalidateCache } from '@/lib/tmux/tmux-capture-cache';

/**
 * How long opencode's `esc again to interrupt` label stays up (ms).
 *
 * Measured on 1.18.21 by sampling the footer every ~360 ms after a single
 * Escape: the label is present from 0.31 s through 4.71 s and the row has
 * reverted to `esc interrupt` by 5.07 s. A second press later than this is not
 * an interrupt at all — it opens a NEW window and leaves the turn running,
 * which is the failure direction the Issue calls out.
 */
const MEASURED_SECOND_PRESS_DEADLINE_MS = 5_000;

const sendSpecialKeyMock = vi.mocked(sendSpecialKey);
const invalidateCacheMock = vi.mocked(invalidateCache);

describe('Issue #1894: OpenCodeTool.interrupt sends two Escapes', () => {
  let tool: OpenCodeTool;

  beforeEach(() => {
    vi.clearAllMocks();
    sendSpecialKeyMock.mockResolvedValue(undefined);
    tool = new OpenCodeTool();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('overrides the single-Escape default rather than inheriting it', () => {
    // The regression itself was an inherited method. If someone deletes the
    // override, every timing assertion below would still have to be rewritten,
    // but this line is what says why in one word.
    expect(OpenCodeTool.prototype.interrupt).not.toBe(BaseCLITool.prototype.interrupt);
  });

  it('presses Escape exactly twice, on the session it was asked about', async () => {
    await tool.interrupt('wt-1894');

    expect(sendSpecialKeyMock).toHaveBeenCalledTimes(2);
    expect(sendSpecialKeyMock).toHaveBeenNthCalledWith(1, 'mcbd-opencode-wt-1894', 'Escape');
    expect(sendSpecialKeyMock).toHaveBeenNthCalledWith(2, 'mcbd-opencode-wt-1894', 'Escape');
  });

  it('addresses an additional instance rather than the primary pane', async () => {
    // Issue #868: an extra instance is a separate tmux session. Interrupting the
    // primary one instead would abort the wrong agent's turn.
    await tool.interrupt('wt-1894', 'opencode-2');

    expect(sendSpecialKeyMock).toHaveBeenCalledTimes(2);
    for (const call of sendSpecialKeyMock.mock.calls) {
      expect(call[0]).toBe('mcbd-opencode-wt-1894-2');
      expect(call[1]).toBe('Escape');
    }
  });

  it('holds the second press until the configured delay has elapsed', async () => {
    vi.useFakeTimers();

    const pending = tool.interrupt('wt-1894');

    // The first press goes out immediately — the label has to be armed before
    // the wait, not after it.
    await vi.advanceTimersByTimeAsync(0);
    expect(sendSpecialKeyMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS - 1);
    expect(
      sendSpecialKeyMock,
      'the second Escape went out before the configured delay',
    ).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1);
    expect(
      sendSpecialKeyMock,
      'the second Escape did not go out at the configured delay',
    ).toHaveBeenCalledTimes(2);

    await pending;
  });

  it('lands the second press well inside the measured five-second window', () => {
    // The dangerous direction: a second press past the deadline opens a new
    // window instead of interrupting, so the pane just collects Escapes while
    // the turn keeps running.
    expect(OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS).toBeLessThan(
      MEASURED_SECOND_PRESS_DEADLINE_MS,
    );
    // Half the deadline would already be uncomfortable on a loaded machine,
    // where each `tmux send-keys` execution around the wait costs more.
    expect(OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS).toBeLessThanOrEqual(
      MEASURED_SECOND_PRESS_DEADLINE_MS / 2,
    );
    // And the other direction: a zero-length gap would risk the second press
    // arriving before opencode has armed the label.
    expect(OPENCODE_INTERRUPT_SECOND_ESCAPE_DELAY_MS).toBeGreaterThan(0);
  });

  it('invalidates the capture cache, so the next poll sees the aborted pane', async () => {
    // Issue #405 / #1911: the capture cache has a 5 s TTL, which is the same
    // order as the interrupt window. Without this the frame that says the turn
    // was aborted can be served from before the Escapes.
    await tool.interrupt('wt-1894');

    expect(invalidateCacheMock).toHaveBeenCalledWith('mcbd-opencode-wt-1894');
  });

  it('propagates a tmux failure instead of reporting a silent success', async () => {
    sendSpecialKeyMock.mockRejectedValueOnce(new Error('no server running'));

    await expect(tool.interrupt('wt-1894')).rejects.toThrow('no server running');
    // And it stops there: a second Escape into a dead session is noise, and the
    // route's error path is what the operator needs to see.
    expect(sendSpecialKeyMock).toHaveBeenCalledTimes(1);
  });
});
