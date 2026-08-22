/**
 * Issue #1895: which slash commands `CopilotTool.sendMessage` treats as pickers.
 *
 * Sending one of these is not like sending a message. The picker takes the
 * composer away, so anything typed afterwards lands in the picker's own search
 * field and a stray Enter is a selection. (Measured while capturing the frames
 * for this Issue: text sent into an open `/session` picker created a session,
 * and `/session` is the one picker `esc` does not close.) The branch therefore
 * sends the command, waits for positive evidence the picker is up, and stops —
 * it must not fall through to `sendMessageWithSubmitVerification`, whose
 * read-back looks for a composer that is no longer on screen.
 *
 * The set was three entries (`model`, `agent`, `theme`) with a note saying to
 * widen it "once the pattern actually matches 1.0.80 frames", which is what
 * `isCopilotSelectionFrame` now does. All eleven commands #1913 enumerated are
 * covered here.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CopilotTool } from '@/lib/cli-tools/copilot';

vi.mock('child_process', async () => {
  const actual = await vi.importActual<typeof import('child_process')>('child_process');
  return { ...actual, execFile: vi.fn() };
});

vi.mock('@/lib/cli-tools/copilot-executable', () => ({
  resolveCopilotExecutable: vi.fn(),
}));

vi.mock('@/lib/tmux/tmux', () => ({
  hasSession: vi.fn().mockResolvedValue(true),
  createSession: vi.fn().mockResolvedValue(undefined),
  sendKeys: vi.fn().mockResolvedValue(undefined),
  sendSpecialKey: vi.fn().mockResolvedValue(undefined),
  killSession: vi.fn().mockResolvedValue(true),
  capturePane: vi.fn().mockResolvedValue(''),
  reconcileSessionGeometry: vi.fn().mockResolvedValue(false),
}));

vi.mock('@/lib/cli-tools/submit-verified-sender', () => ({
  sendMessageWithSubmitVerification: vi.fn().mockResolvedValue(undefined),
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
    withContext: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
  }),
}));

/** The eleven commands measured on copilot 1.0.80 (Issue #1913 / #1895). */
const PICKER_COMMANDS = [
  'model',
  'agent',
  'theme',
  'permissions',
  'skills',
  'mcp',
  'settings',
  'statusline',
  'subagents',
  'resume',
  'session',
] as const;

/** The idle frame copilot draws before the command is sent. */
const IDLE_FRAME = [
  ' /work/repo [⎇ main]                              Session: 0 AIC used',
  '────────────────────────────────────────────────────────────────────',
  '❯ ',
  '────────────────────────────────────────────────────────────────────',
  ' ← open sidebar · / commands · ? help · tab next tab   GPT-5.6 Terra',
].join('\n');

/** A picker frame: copilot's chrome is gone and a key-hint footer is last. */
const PICKER_FRAME = [
  '   Recommended models',
  ' ❯ Auto                       —          —',
  ' ──────────────────────────────────────────────',
  ' ❯  Search models…',
  ' ──────────────────────────────────────────────',
  ' ↑/↓ to navigate · enter to select · esc to cancel',
].join('\n');

/**
 * capturePane as the real sequence delivers it: the composer is still up when
 * `waitForPrompt` looks, and the picker has replaced it by the time
 * `waitForSelectionList` does.
 */
function mockPaneSequence(capturePane: ReturnType<typeof vi.fn>): void {
  let calls = 0;
  capturePane.mockImplementation(async () => (++calls === 1 ? IDLE_FRAME : PICKER_FRAME));
}

describe('Issue #1895: copilot picker slash commands', () => {
  let tool: CopilotTool;

  beforeEach(() => {
    vi.clearAllMocks();
    tool = new CopilotTool();
  });

  it.each(PICKER_COMMANDS)('sends /%s down the picker branch, not the message branch', async (command) => {
    const { capturePane, sendKeys, hasSession } = await import('@/lib/tmux/tmux');
    const { sendMessageWithSubmitVerification } = await import('@/lib/cli-tools/submit-verified-sender');
    vi.mocked(hasSession).mockResolvedValue(true);
    mockPaneSequence(vi.mocked(capturePane));

    await tool.sendMessage('wt', `/${command}`);

    expect(sendKeys).toHaveBeenCalledWith('mcbd-copilot-wt', `/${command}`, true);
    expect(sendMessageWithSubmitVerification).not.toHaveBeenCalled();
  });

  it('returns as soon as the picker is on screen instead of expiring the 5s window', async () => {
    // The reported symptom on the three commands that WERE in the set: the
    // pattern matched none of 1.0.80's frames, so every send burned the full
    // window and logged `copilot-selection-list-not-detected-timeout`.
    vi.useFakeTimers();
    const { capturePane, hasSession } = await import('@/lib/tmux/tmux');
    vi.mocked(hasSession).mockResolvedValue(true);
    mockPaneSequence(vi.mocked(capturePane));

    const promise = tool.sendMessage('wt', '/model');
    await vi.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toBeUndefined();

    vi.useRealTimers();
  });

  it('leaves every other slash command on the ordinary message path', async () => {
    // Widening the set is not free — each entry buys a wait — so it must stay
    // the measured eleven rather than "anything starting with a slash".
    const { capturePane, hasSession } = await import('@/lib/tmux/tmux');
    const { sendMessageWithSubmitVerification } = await import('@/lib/cli-tools/submit-verified-sender');
    vi.mocked(hasSession).mockResolvedValue(true);

    for (const message of ['/help', '/init', '/clear', '/compact', 'plain message']) {
      vi.mocked(sendMessageWithSubmitVerification).mockClear();
      mockPaneSequence(vi.mocked(capturePane));

      await tool.sendMessage('wt', message);

      expect(
        sendMessageWithSubmitVerification,
        `${message} was treated as a picker`,
      ).toHaveBeenCalledTimes(1);
    }
  });
});
