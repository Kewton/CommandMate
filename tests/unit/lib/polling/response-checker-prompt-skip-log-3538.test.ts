/**
 * Issue #3538: `duplicate-prompt-skipped` was logged on every duplicate tick.
 *
 * A full-screen TUI (copilot, opencode) keeps polling while a prompt is on
 * screen, so an unanswered prompt wrote the same line every 2 s. Thinned the
 * way #3519 thinned `duplicate-response-skipped`: the first duplicate tick of a
 * run, then one in every N.
 *
 * Drives the real `checkForResponse` on copilot (same harness and fixture as
 * the #1695 suite — the prompt guard only fires for the full-screen TUIs),
 * because the thinning has to happen at the skip site, and because the #1695
 * tally (`recordPromptDedupSkip`) must still be counted on every tick.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
  getWorktreeById: () => ({ id: 'wt-3538', name: 'wt-3538' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL } from '@/lib/polling/prompt-dedup';
import { clearPromptDedupSkips, getPromptDedupSkips } from '@/lib/polling/prompt-dedup-state';

const WT = 'wt-3538';
const N = DUPLICATE_PROMPT_SKIP_LOG_TICK_INTERVAL;

/** The copilot permission dialog from the live capture (#2457, used by #1695). */
const PROMPT_A = readFileSync(
  path.resolve(__dirname, '../detection/fixtures/copilot-live-1885/permission-dialog.txt'),
  'utf8',
);
/** The same dialog asking about a different command — a new prompt, same layout. */
const PROMPT_B = PROMPT_A.replace('sleep 25; echo finished', 'sleep 26; echo finished');
/** Copilot mid-turn, no prompt on screen (same live capture set). */
const WORKING = readFileSync(
  path.resolve(__dirname, '../detection/fixtures/copilot-live-1885/turn-running-thinking.txt'),
  'utf8',
);

function skipLogs(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls
    .filter(([action]) => action === 'duplicate-prompt-skipped')
    .map(([, data]) => data as Record<string, unknown>);
}

function savedPrompts(): number {
  return createMessage.mock.calls.filter(([, m]) => m.messageType === 'prompt').length;
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await checkForResponse(WT, 'copilot');
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPromptDedupSkips();
  stopPolling(WT, 'copilot');
  stopPolling(WT, 'copilot', 'copilot-2');
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #3538: duplicate-prompt-skipped is thinned at the skip site', () => {
  it('sanity: every tick after the first is a duplicate prompt skip', async () => {
    expect(PROMPT_B).not.toBe(PROMPT_A);
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    expect(await checkForResponse(WT, 'copilot')).toBe(true);
    for (let i = 0; i < 3; i++) expect(await checkForResponse(WT, 'copilot')).toBe(false);
    expect(savedPrompts()).toBe(1);
  });

  it('the first duplicate tick logs, in the shape it always had', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(2);

    expect(skipLogs()).toEqual([{ worktreeId: WT, cliToolId: 'copilot' }]);
  });

  it('the duplicate ticks in between do not log', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    // 1 save + N duplicate ticks: only the first duplicate logs.
    await ticks(1 + N);

    expect(skipLogs()).toHaveLength(1);
  });

  it('the duplicate tick N after the first logs again, with the run length and suppressed count', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(1 + N + 1);

    expect(skipLogs()).toEqual([
      { worktreeId: WT, cliToolId: 'copilot' },
      { worktreeId: WT, cliToolId: 'copilot', consecutive: N + 1, suppressed: N - 1 },
    ]);
  });

  it('recordPromptDedupSkip is still counted on every duplicate tick', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(1 + 2 * N + 1);

    // Every duplicate tick is tallied for `capture --json` (#1695) …
    expect(getPromptDedupSkips(WT, 'copilot').skippedCount).toBe(2 * N + 1);
    // … while only the first and every Nth are logged.
    expect(skipLogs()).toHaveLength(3);
  });

  it('a new prompt restarts the count, so its first duplicate tick logs', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(5);
    expect(skipLogs()).toHaveLength(1);

    captureSessionOutput.mockResolvedValue(PROMPT_B);
    expect(await checkForResponse(WT, 'copilot')).toBe(true);
    await checkForResponse(WT, 'copilot');

    expect(savedPrompts()).toBe(2);
    expect(skipLogs()).toHaveLength(2);
    expect(skipLogs()[1]).toEqual({ worktreeId: WT, cliToolId: 'copilot' });
  });

  it('stopPolling ends the count with the hash, so the next cycle logs its first duplicate', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(5);
    expect(skipLogs()).toHaveLength(1);

    stopPolling(WT, 'copilot');
    // The hash went with it, so the same prompt is saved again, then skipped.
    expect(await checkForResponse(WT, 'copilot')).toBe(true);
    await checkForResponse(WT, 'copilot');

    expect(skipLogs()).toHaveLength(2);
    expect(skipLogs()[1]).toEqual({ worktreeId: WT, cliToolId: 'copilot' });
  });

  it('counts are per instance', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(5);
    await checkForResponse(WT, 'copilot', 'copilot-2');
    await checkForResponse(WT, 'copilot', 'copilot-2');

    expect(skipLogs()).toHaveLength(2);
    expect(getPromptDedupSkips(WT, 'copilot', 'copilot-2').skippedCount).toBe(1);
  });

  it('a tick without the prompt ends the run, so the prompt coming back logs its first duplicate', async () => {
    captureSessionOutput.mockResolvedValue(PROMPT_A);
    await ticks(2);
    expect(skipLogs()).toHaveLength(1);

    captureSessionOutput.mockResolvedValue(WORKING);
    expect(await checkForResponse(WT, 'copilot')).toBe(false);

    captureSessionOutput.mockResolvedValue(PROMPT_A);
    // The hash is kept, so the returning prompt is still not saved again …
    expect(await checkForResponse(WT, 'copilot')).toBe(false);
    expect(savedPrompts()).toBe(1);
    // … but its duplicate is the first of a new run and logs, in the first-tick shape.
    expect(skipLogs()).toEqual([
      { worktreeId: WT, cliToolId: 'copilot' },
      { worktreeId: WT, cliToolId: 'copilot' },
    ]);
    // The #1695 tally counts both skips.
    expect(getPromptDedupSkips(WT, 'copilot').skippedCount).toBe(2);
  });
});
