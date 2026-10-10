/**
 * Issue #3519: `duplicate-response-skipped` was logged on every duplicate tick.
 *
 * The poller ticks every 2 s for up to 900 ticks a cycle, so a finished screen
 * that stayed up wrote the same line for the whole cycle — 51,933 lines in 24 h
 * (80% of the server log). The line exists so that a reply missing from History
 * leaves a grep-able trace (#1695); one at the start of a run and one about
 * every minute after keeps that, at a thirtieth of the volume.
 *
 * Drives the real `checkForResponse` (same harness as the #1695 suite), because
 * the thinning has to happen at the skip site — a test of the counter alone
 * would pass with the call site still logging every tick.
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
  getWorktreeById: () => ({ id: 'wt-3519', name: 'wt-3519' }),
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
import { DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL } from '@/lib/polling/response-dedup';

const WT = 'wt-3519';
const N = DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL;

/** A finished claude turn on a 1000-row alternate-screen pane (same as #1695). */
const SEPARATOR = '─'.repeat(40);
const STATUS_BAR = '  ⏸ manual mode on · ? for shortcuts · ← for agents                       focus';
function responsePane(reply: string): string {
  const head = ['❯ summarize the project', `⏺ ${reply}`];
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}
const PANE_A = responsePane('CommandMate is a Git worktree management tool.');
const PANE_B = responsePane('It also integrates tmux sessions with CLI agents.');

function skipLogs(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls
    .filter(([action]) => action === 'duplicate-response-skipped')
    .map(([, data]) => data as Record<string, unknown>);
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await checkForResponse(WT, 'claude');
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #3519: duplicate-response-skipped is thinned at the skip site', () => {
  it('sanity: every tick after the first is a duplicate skip', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    for (let i = 0; i < 3; i++) expect(await checkForResponse(WT, 'claude')).toBe(false);
    expect(createMessage).toHaveBeenCalledTimes(1);
  });

  it('the first duplicate tick logs, in the #1695 shape', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(2);

    expect(skipLogs()).toEqual([{ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' }]);
  });

  it('the duplicate ticks in between do not log', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    // 1 save + N duplicate ticks: only the first duplicate logs.
    await ticks(1 + N);

    expect(skipLogs()).toHaveLength(1);
  });

  it('the duplicate tick N after the first logs again, with the run length and suppressed count', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(1 + N + 1);

    expect(skipLogs()).toEqual([
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' },
      { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude', consecutive: N + 1, suppressed: N - 1 },
    ]);
  });

  it('a full 30-minute cycle (900 ticks) logs about once a minute, not 900 times', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(900);

    // 899 duplicate ticks after the save.
    expect(skipLogs()).toHaveLength(Math.ceil(899 / N));
    expect(skipLogs().length).toBeLessThan(900 * 0.4);
  });

  it('a new response restarts the count, so its first duplicate tick logs', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(5);
    expect(skipLogs()).toHaveLength(1);

    captureSessionOutput.mockResolvedValue(PANE_B);
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await checkForResponse(WT, 'claude');

    expect(skipLogs()).toHaveLength(2);
    expect(skipLogs()[1]).toEqual({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
  });

  it('stopPolling ends the count with the hash, so the next cycle logs its first duplicate', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(5);
    expect(skipLogs()).toHaveLength(1);

    stopPolling(WT, 'claude');
    // Same content in the next cycle is saved again (#1268), then skipped.
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    await checkForResponse(WT, 'claude');

    expect(skipLogs()).toHaveLength(2);
    expect(skipLogs()[1]).toEqual({ worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' });
  });

  it('counts are per instance', async () => {
    captureSessionOutput.mockResolvedValue(PANE_A);
    await ticks(5);
    await checkForResponse(WT, 'claude', 'claude-2');
    await checkForResponse(WT, 'claude', 'claude-2');

    expect(skipLogs().map((d) => d.instanceId)).toEqual(['claude', 'claude-2']);
    stopPolling(WT, 'claude', 'claude-2');
  });
});
