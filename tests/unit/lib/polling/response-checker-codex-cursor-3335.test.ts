/**
 * Issue #3335 — codex 0.160.0 and the poller's cursor (path A).
 *
 * codex 0.160.0 draws in the alternate screen (`#{alternate_on}` 1,
 * `#{history_size}` 0): every capture is the 1000-row pane, the composer is
 * pinned to row 996, and the transcript grows from the top. The poller's
 * `lastCapturedLine` is a row count of that pane, so it is not a read cursor:
 * after the startup screen it is 996 (the composer row, written by the poller)
 * or 999/1000 (the row count, written by the pre-send flush and by the cursor
 * advance after codex's transcript wrote the turn), and the reply is drawn above
 * all of them.
 *
 * Decided here (option (a) of the Issue): the screen read does not take the
 * reply from such a pane, and the row count keeps its meaning — it is not
 * reinterpreted as an echo anchor. codex's reply reaches History from its own
 * transcript (`hooks/sources/codex/history.ts`). What is pinned is that every
 * cursor those writers leave yields no row — in particular the 1000 the flush
 * leaves, from which `extractResponse` re-reads the pane from the top (banner
 * included) and only the `lineCount <= lastCapturedLine` check keeps it out of
 * History.
 *
 * The frames are captures of the real tool — see
 * `tests/fixtures/startup-screen-3293/README.md`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { stripAnsi } from '@/lib/detection/cli-patterns';

// ---------------------------------------------------------------------------
// Module boundary mocks (the set the #2400 suite cuts)
// ---------------------------------------------------------------------------

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
const getSessionState = vi.fn();
const updateSessionState = vi.fn();
const getWorktreeById = vi.fn(() => ({ id: 'wt-1', name: 'wt-1' }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  updateSessionState: (...a: unknown[]) => updateSessionState(...a),
  getWorktreeById: (...a: unknown[]) => getWorktreeById(...(a as [])),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

const notifyPushSubscribers = vi.fn(async (..._a: unknown[]) => {});
vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (...a: unknown[]) => notifyPushSubscribers(...a),
}));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { buildCodexLongReplyPane } from '../../../fixtures/startup-screen-3293/codex-0.160.0-long-reply-pane';

// ---------------------------------------------------------------------------
// Frames
// ---------------------------------------------------------------------------

const FIXTURES = join(__dirname, '../../../fixtures');
const read = (rel: string): string => readFileSync(join(FIXTURES, rel), 'utf-8');

const CODEX_BOOT = read('startup-screen-3293/codex-0.160.0-boot-idle.txt');
const CODEX_BOOT_TYPED = read('startup-screen-3293/codex-0.160.0-boot-typed.txt');
const CODEX_TURN_INTERRUPTED = read('startup-screen-3293/codex-0.160.0-first-turn-interrupted.txt');
const CODEX_TURN_REPLY = read('startup-screen-3293/codex-0.160.0-first-turn-reply.txt');
const CODEX_OVERFLOW = read('startup-screen-3293/codex-0.160.0-overflow-interrupted.txt');
const CODEX_LONG_REPLY = buildCodexLongReplyPane();

/** Row index of the first row whose stripped text starts with `prefix`. */
function rowOf(capture: string, prefix: string): number {
  const index = capture.split('\n').findIndex(row => stripAnsi(row).startsWith(prefix));
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

/** A session_states row that the tick reads and writes, as the real one would. */
function wireLiveSessionState(initial: number): { cursor: () => number } {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
  return { cursor: () => lastCapturedLine };
}

const AFTER_TURN_FRAMES = [
  ['the first reply', CODEX_TURN_REPLY],
  ['an interrupted turn', CODEX_TURN_INTERRUPTED],
  ['an overflowed transcript', CODEX_OVERFLOW],
  ['a reply longer than the pane', CODEX_LONG_REPLY],
] as const;

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'codex');
  isSessionRunning.mockResolvedValue(true);
});

describe('[#3335] the cursors codex 0.160.0 is left with', () => {
  it('the fixture premise: every frame is 1000 rows with the composer on row 996', () => {
    for (const capture of [CODEX_BOOT, CODEX_BOOT_TYPED, ...AFTER_TURN_FRAMES.map(([, c]) => c)]) {
      expect(capture.replace(/\n$/, '').split('\n')).toHaveLength(1000);
      const rows = capture.split('\n').map(stripAnsi);
      expect(rows.findIndex((row, i) => i >= 990 && /^› /.test(row))).toBe(996);
    }
  });

  it('the startup screen leaves the poller at the composer row, and the cursor never moves from it', () => {
    // The poller's cursor (#3293): the composer row.
    expect(extractResponse(CODEX_BOOT, 0, 'codex')?.lineCount).toBe(996);
    // Every later frame reports the same lineCount from there: the cursor never moves.
    for (const [, capture] of AFTER_TURN_FRAMES) {
      expect(extractResponse(capture, 996, 'codex')?.lineCount).toBe(996);
    }
  });
});

describe('[#3335] checkForResponse: no row from a cursor parked at or below the composer', () => {
  it.each(AFTER_TURN_FRAMES)('%s: cursors 996-1000 save nothing and are not moved back', async (_name, capture) => {
    for (const parked of [996, 997, 998, 999, 1000]) {
      const state = wireLiveSessionState(parked);
      captureSessionOutput.mockResolvedValue(capture);

      expect(await checkForResponse('wt-1', 'codex')).toBe(false);
      expect(state.cursor()).toBeGreaterThanOrEqual(996);
    }

    expect(createMessage).not.toHaveBeenCalled();
  });

  it('from the 1000 the flush leaves, extraction re-reads the pane from the top — the banner is in it', () => {
    // Why the case above matters: this is what the `lineCount <= lastCapturedLine`
    // check keeps out of History. The row count is not reinterpreted here.
    const result = extractResponse(CODEX_TURN_REPLY, 1000, 'codex');

    expect(stripAnsi(result!.response)).toContain('>_ OpenAI Codex (v0.160.0)');
    expect(result!.lineCount).toBeLessThan(1000);
  });

  it('陰性対照: from the row under the echo the reply is still saved', async () => {
    wireLiveSessionState(rowOf(CODEX_TURN_REPLY, '› Reply with exactly') + 1);
    captureSessionOutput.mockResolvedValue(CODEX_TURN_REPLY);

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);

    const saved = createMessage.mock.calls
      .filter(([, m]) => m.role === 'assistant')
      .map(([, m]) => stripAnsi(String(m.content)));
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('UAT-OK-CODEX');
    expect(saved[0]).not.toContain('OpenAI Codex');
  });
});
