/**
 * Issue #1695: a dedup skip must leave a trace outside the server log.
 *
 * Both guards drop content the poller had already extracted, and from
 * `commandmate capture --json` the result was indistinguishable from the
 * detection layer never having classified the frame (Issue #1676) — both say
 * "nothing was recorded". This suite drives the real `checkForResponse`, because
 * the whole point is the wiring at the two skip sites; a test that called
 * `recordPromptDedupSkip` directly would pass with the call site removed.
 *
 * Tool choice is not arbitrary. `checkForResponse` calls `stopPolling` right
 * after saving a prompt for every tool that is NOT a full-screen TUI, and
 * `stopPolling` clears the prompt hash cache — so for claude/codex the second
 * poll sees an empty cache and saves the prompt again (measured: both save
 * twice). The prompt guard therefore only ever fires for the full-screen TUIs it
 * was written for (Issue #565), which is why the prompt half of this suite runs
 * on copilot and the response half on claude.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Built inside vi.hoisted() rather than from tests/helpers/logger-mock, because
// `@/lib/logger` is pulled in transitively by `cli-patterns` during the hoisted
// vi.mock factory — a plain `const` above the factory is still in the temporal
// dead zone by then.
const mockLogger = vi.hoisted(() => {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    withContext: vi.fn(),
  };
  logger.withContext.mockReturnValue(logger);
  return logger;
});
vi.mock('@/lib/logger', () => ({
  createLogger: vi.fn(() => mockLogger),
  generateRequestId: vi.fn(() => 'test-request-id'),
}));

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null })),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-1695', name: 'wt-1695' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import {
  getPromptDedupSkips,
  clearPromptDedupSkips,
} from '@/lib/polling/prompt-dedup-state';

const WT = 'wt-1695';

/** A permission prompt, transcribed from the shape a live pane carries. */
const PROMPT_PANE = [
  '❯ apply the refactor',
  '',
  '⏺ I need permission to edit the file.',
  '',
  'Do you want to make this edit to useVirtualKeyboard.ts?',
  '❯ 1. Yes',
  '  2. Yes, allow all edits during this session (shift+tab)',
  '  3. No',
  '',
  'Esc to cancel · Tab to amend',
].join('\n');

/**
 * A finished claude turn with no prompt on it — the response guard's input.
 *
 * Same shape as the #1268 fixture: the transcript at the top, blank filler, and
 * the footer (separator / input box / separator / status bar) pinned to the
 * bottom of a 1000-row alternate-screen pane. A bare two-line transcript is not
 * enough — extraction anchors on the footer, and without it nothing is saved.
 */
const SEPARATOR = '─'.repeat(40);
const STATUS_BAR = '  ⏸ manual mode on · ? for shortcuts · ← for agents                       focus';
const RESPONSE_PANE = (() => {
  const head = ['❯ summarize the project', '⏺ CommandMate is a Git worktree management tool.'];
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
})();

function savedMessageTypes(): string[] {
  return createMessage.mock.calls.map(([, m]) => String(m.messageType));
}

function loggedActions(): string[] {
  return mockLogger.info.mock.calls.map(([action]) => String(action));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPromptDedupSkips();
  stopPolling(WT, 'copilot');
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #1695: prompt dedup skips are counted', () => {
  it('sanity: the second poll of the same prompt really is suppressed', async () => {
    // Guards the premise. If copilot stopped re-polling a prompt it is sitting
    // on, the assertions below would pass vacuously against a guard that never
    // ran.
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);

    expect(await checkForResponse(WT, 'copilot')).toBe(true);
    expect(await checkForResponse(WT, 'copilot')).toBe(false);
    expect(savedMessageTypes()).toEqual(['prompt']);
  });

  it('records the skip count and the time of the last skip', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);
    const before = Date.now();

    await checkForResponse(WT, 'copilot');
    await checkForResponse(WT, 'copilot');
    await checkForResponse(WT, 'copilot');
    const after = Date.now();

    const skips = getPromptDedupSkips(WT, 'copilot');
    // Three polls, one save, two suppressions.
    expect(skips.skippedCount).toBe(2);
    expect(skips.lastSkippedAt).toBeGreaterThanOrEqual(before);
    expect(skips.lastSkippedAt).toBeLessThanOrEqual(after);
  });

  it('leaves the tally at zero when nothing was suppressed', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);

    await checkForResponse(WT, 'copilot');

    expect(getPromptDedupSkips(WT, 'copilot')).toEqual({
      skippedCount: 0,
      lastSkippedAt: null,
    });
  });

  it('attributes the skip to the instance that skipped', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_PANE);

    await checkForResponse(WT, 'copilot', 'copilot-2');
    await checkForResponse(WT, 'copilot', 'copilot-2');

    expect(getPromptDedupSkips(WT, 'copilot', 'copilot-2').skippedCount).toBe(1);
    expect(getPromptDedupSkips(WT, 'copilot').skippedCount).toBe(0);
  });
});

describe('Issue #1695: response dedup skips are logged', () => {
  it('sanity: the second poll of the same finished turn really is suppressed', async () => {
    // Claude renders in the alternate screen, so the line-count cursor is
    // disabled (#1268) and the content guard is what suppresses the re-save.
    captureSessionOutput.mockResolvedValue(RESPONSE_PANE);

    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(await checkForResponse(WT, 'claude')).toBe(false);
    expect(savedMessageTypes()).toEqual(['normal']);
  });

  it('logs the skip, which used to leave no trace at all', async () => {
    captureSessionOutput.mockResolvedValue(RESPONSE_PANE);

    await checkForResponse(WT, 'claude');
    expect(loggedActions()).not.toContain('duplicate-response-skipped');

    await checkForResponse(WT, 'claude');

    expect(loggedActions()).toContain('duplicate-response-skipped');
    expect(mockLogger.info).toHaveBeenCalledWith('duplicate-response-skipped', {
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude',
    });
  });

  it('names the instance that skipped, not just the tool', async () => {
    captureSessionOutput.mockResolvedValue(RESPONSE_PANE);

    await checkForResponse(WT, 'claude', 'claude-2');
    await checkForResponse(WT, 'claude', 'claude-2');

    expect(mockLogger.info).toHaveBeenCalledWith('duplicate-response-skipped', {
      worktreeId: WT,
      cliToolId: 'claude',
      instanceId: 'claude-2',
    });
  });
});
