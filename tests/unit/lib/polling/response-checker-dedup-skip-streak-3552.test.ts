/**
 * Issue #3552: the run of `duplicate-response-skipped` ticks (#3519) did not
 * end on a tick that was not a duplicate.
 *
 * The count only went back to zero when a NEW reply passed the content guard,
 * on `stopPolling` and on a rename. A frame that is not the saved reply at all
 * — an unfinished one, a live prompt, an empty response — left it standing, so
 * when the same reply came back its first duplicate was counted as the
 * continuation of the old run and did not log (up to 29 ticks of silence), and
 * the `consecutive` of the next line counted across the gap. The prompt side
 * was fixed the same way in #3538.
 *
 * Drives the real `checkForResponse` on claude (same harness as the #3519
 * suite), because the reset has to happen at the sites that read the frame.
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
  getWorktreeById: () => ({ id: 'wt-3552', name: 'wt-3552' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

// The prompt path stops its own chain. Inside a real chain that stop is a pause
// (#2230: the response hash is kept and the `/respond` restart resumes the
// cycle); called bare, as here, it would be an explicit stop that drops the
// hash. `pauseOnNextStop` makes the next call stand in for the pause.
const stopState = vi.hoisted(() => ({ pauseOnNextStop: false }));
vi.mock('@/lib/polling/response-poller-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/polling/response-poller-core')>();
  return {
    ...actual,
    stopPolling: (...a: Parameters<typeof actual.stopPolling>) => {
      if (stopState.pauseOnNextStop) {
        stopState.pauseOnNextStop = false;
        return;
      }
      actual.stopPolling(...a);
    },
  };
});

import { getSessionState } from '@/lib/db';
import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL } from '@/lib/polling/response-dedup';

const WT = 'wt-3552';
const N = DUPLICATE_RESPONSE_SKIP_LOG_TICK_INTERVAL;
const FIRST = { worktreeId: WT, cliToolId: 'claude', instanceId: 'claude' };

/** A claude frame on a 1000-row alternate-screen pane (same layout as #3519). */
const SEPARATOR = '─'.repeat(40);
const STATUS_BAR = '  ⏸ manual mode on · ? for shortcuts · ← for agents                       focus';
function pane(head: string[]): string {
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}
/** The finished reply H. */
const PANE_H = pane(['❯ summarize the project', '⏺ CommandMate is a Git worktree management tool.']);
/** Claude mid-turn: the spinner is up, nothing finished. */
const WORKING = [
  '❯ summarize the project',
  '',
  '✻ Thinking… (esc to interrupt)',
].join('\n');
/** A permission prompt over the conversation (same frame as #1790). */
const PROMPT = [
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
 * A cleared pane with only the composer left: the frame reads as finished and
 * its response is empty (the `!result.response` return of `checkForResponse`).
 */
const EMPTY = pane([]);

function skipLogs(): Array<Record<string, unknown>> {
  return mockLogger.info.mock.calls
    .filter(([action]) => action === 'duplicate-response-skipped')
    .map(([, data]) => data as Record<string, unknown>);
}

function savedResponses(): number {
  return createMessage.mock.calls.filter(([, m]) => m.messageType !== 'prompt').length;
}

async function ticks(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await checkForResponse(WT, 'claude');
}

/** Save H and run it for `duplicates` duplicate ticks. */
async function runH(duplicates: number): Promise<void> {
  captureSessionOutput.mockResolvedValue(PANE_H);
  await ticks(1 + duplicates);
  expect(savedResponses()).toBe(1);
}

beforeEach(() => {
  vi.clearAllMocks();
  stopState.pauseOnNextStop = false;
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #3552: a tick that is not the saved reply ends the duplicate run', () => {
  it('H → unfinished frame → H: the first duplicate after the gap logs, H is not saved again', async () => {
    await runH(3);
    expect(skipLogs()).toEqual([FIRST]);

    captureSessionOutput.mockResolvedValue(WORKING);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    captureSessionOutput.mockResolvedValue(PANE_H);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    expect(savedResponses()).toBe(1);
    expect(skipLogs()).toEqual([FIRST, FIRST]);
  });

  it('H → prompt → pause・resume → H: the first duplicate after the prompt logs, H is not saved again', async () => {
    await runH(3);
    expect(skipLogs()).toEqual([FIRST]);

    captureSessionOutput.mockResolvedValue(PROMPT);
    stopState.pauseOnNextStop = true;
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(createMessage.mock.calls.filter(([, m]) => m.messageType === 'prompt')).toHaveLength(1);
    expect(stopState.pauseOnNextStop).toBe(false);

    captureSessionOutput.mockResolvedValue(PANE_H);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    expect(savedResponses()).toBe(1);
    expect(skipLogs()).toEqual([FIRST, FIRST]);
  });

  it('H → empty response → H: the first duplicate after the gap logs, H is not saved again', async () => {
    await runH(3);

    captureSessionOutput.mockResolvedValue(EMPTY);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    captureSessionOutput.mockResolvedValue(PANE_H);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    expect(savedResponses()).toBe(1);
    expect(skipLogs()).toEqual([FIRST, FIRST]);
  });

  it('the run after the gap counts from 1: its next line is at tick 1 + N, not at the old total', async () => {
    await runH(5);

    captureSessionOutput.mockResolvedValue(WORKING);
    await checkForResponse(WT, 'claude');

    captureSessionOutput.mockResolvedValue(PANE_H);
    await ticks(N + 1);

    expect(skipLogs()).toEqual([
      FIRST,
      FIRST,
      { ...FIRST, consecutive: N + 1, suppressed: N - 1 },
    ]);
  });
});

describe('Issue #3552: ticks that say nothing about the reply keep the run', () => {
  it('an unbroken run of H logs on duplicate ticks 1, 1+N and 1+2N only', async () => {
    await runH(2 * N + 1);

    expect(skipLogs()).toEqual([
      FIRST,
      { ...FIRST, consecutive: N + 1, suppressed: N - 1 },
      { ...FIRST, consecutive: 2 * N + 1, suppressed: N - 1 },
    ]);
  });

  it('a tick that skips extraction on the line count (null) does not end the run', async () => {
    await runH(2);
    expect(skipLogs()).toHaveLength(1);

    // The same frame read against a cursor 10 lines past its 1000 rows:
    // `extractResponse` answers "no new output" (null) without looking at the
    // frame, and the shortfall is too small to count as a buffer reset.
    vi.mocked(getSessionState).mockReturnValueOnce({
      lastCapturedLine: 1010,
      inProgressMessageId: null,
    } as unknown as ReturnType<typeof getSessionState>);
    expect(await checkForResponse(WT, 'claude')).toBe(false);

    // Back to the ordinary cursor: the run carries on, so only tick 1 + N logs.
    await ticks(N - 2);
    expect(skipLogs()).toHaveLength(1);
    await checkForResponse(WT, 'claude');

    expect(savedResponses()).toBe(1);
    expect(skipLogs()).toEqual([FIRST, { ...FIRST, consecutive: N + 1, suppressed: N - 1 }]);
  });
});
