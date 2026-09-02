/**
 * The prompt sweep is published, not silent (Issue #2195).
 *
 * `markPendingPromptsAsAnswered` flips every still-pending prompt row of an
 * instance to answered as soon as the poller sees that the agent moved on. It
 * was the only history mutation with no realtime frame behind it, so an open
 * chat surface kept showing "waiting for your answer" until its next
 * `/messages` poll — and #2195 demotes that poll to a 15s fallback whenever a
 * socket is up, tripling how long the stale prompt card survives.
 *
 * Both call sites are covered, because they are reached by opposite frames:
 *  - the *thinking* frame, where the response is not complete yet;
 *  - the *reply* frame, where a complete response has been extracted.
 *
 * Driven through the real `checkForResponse` so the assertion is about the
 * wiring rather than about the helper existing. `#2195`'s DB-side contract
 * (what `onUpdated` hands back) is pinned separately, on a real database, in
 * `tests/unit/db/mark-pending-prompts-broadcast-2195.test.ts`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '@/lib/db/db-migrations';
import type { ChatMessage } from '@/types/models';

let db: Database.Database;

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

/** The prompt row the sweep is about to stamp, as the DB would read it back. */
const SWEPT_ROW: ChatMessage = {
  id: 'prompt-row-1',
  worktreeId: 'wt-2195s',
  role: 'assistant',
  content: 'Do you want to make this edit?',
  timestamp: new Date('2024-01-01T00:00:00.000Z'),
  messageType: 'prompt',
  promptData: {
    type: 'yes_no',
    question: 'Do you want to make this edit?',
    status: 'answered',
    options: ['yes', 'no'],
    answer: '(answered via terminal)',
    answeredBy: 'terminal',
  },
  cliToolId: 'claude',
  instanceId: 'claude',
  archived: false,
};

/**
 * Stands in for the real sweep: reports one stamped row through `onUpdated`,
 * exactly as `chat-db` does. A 4-argument call (the pre-#2195 shape) reports
 * nothing, which is what makes the "wired up" assertion non-vacuous.
 */
const markPendingPromptsAsAnswered = vi.fn(
  (
    _db: unknown,
    _worktreeId: string,
    _cliToolId: string,
    _instanceId?: string,
    onUpdated?: (message: ChatMessage) => void
  ) => {
    onUpdated?.(SWEPT_ROW);
    return 1;
  }
);

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn(() => ({ lastCapturedLine: 0, inProgressMessageId: null }));
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...(a as [])),
  updateSessionState: vi.fn(),
  getWorktreeById: () => ({ id: 'wt-2195s', name: 'feature-x', path: '/tmp/wt-2195s' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: (
    ...a: Parameters<typeof markPendingPromptsAsAnswered>
  ) => markPendingPromptsAsAnswered(...a),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => db }));

const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({
  broadcastMessage: (...a: unknown[]) => broadcastMessage(...a),
}));

vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';

const WT = 'wt-2195s';

/** A claude pane mid-turn: the thinking spinner, no complete response yet. */
const THINKING_PANE = [
  '❯ apply the refactor',
  '',
  '⏺ Working on it.',
  '',
  '✻ Thinking… (12s · esc to interrupt)',
].join('\n');

/** The same pane once the reply has landed. */
const REPLY_PANE = [
  '❯ apply the refactor',
  '⏺ Done — the hook now debounces resize events.',
  '',
  '─'.repeat(40),
  '❯ ',
  '─'.repeat(40),
  '  ⏸ manual mode on · ? for shortcuts                       focus',
].join('\n');

function updatedFrames(): Array<{ worktreeId: string; message: ChatMessage }> {
  return broadcastMessage.mock.calls
    .filter(([type]) => type === 'message_updated')
    .map(([, payload]) => payload as { worktreeId: string; message: ChatMessage });
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  vi.clearAllMocks();
  isSessionRunning.mockResolvedValue(true);
  getSessionState.mockReturnValue({ lastCapturedLine: 0, inProgressMessageId: null });
  markPendingPromptsAsAnswered.mockImplementation((_db, _w, _c, _i, onUpdated) => {
    onUpdated?.(SWEPT_ROW);
    return 1;
  });
  stopPolling(WT, 'claude');
});

afterEach(() => {
  db.close();
});

describe("Issue #2195: the prompt sweep broadcasts 'message_updated'", () => {
  it('publishes the swept row from the thinking frame', async () => {
    captureSessionOutput.mockResolvedValue(THINKING_PANE);

    await checkForResponse(WT, 'claude');

    // The sweep is reached with a callback at all — the pre-#2195 call passed
    // only four arguments and could never have published anything.
    expect(markPendingPromptsAsAnswered).toHaveBeenCalled();
    expect(typeof markPendingPromptsAsAnswered.mock.calls[0][4]).toBe('function');

    expect(updatedFrames()).toHaveLength(1);
    expect(updatedFrames()[0].worktreeId).toBe(WT);
    expect(updatedFrames()[0].message).toBe(SWEPT_ROW);
  });

  it('publishes the swept row from the completed-reply frame', async () => {
    captureSessionOutput.mockResolvedValue(REPLY_PANE);

    await checkForResponse(WT, 'claude');

    expect(updatedFrames()).toHaveLength(1);
    expect(updatedFrames()[0].message.id).toBe(SWEPT_ROW.id);
  });

  it("uses 'message_updated', never 'message', so the pane replaces the card", async () => {
    // The row already exists and was already delivered when it was created; a
    // `message` for the same id would show the question a second time in a
    // client that appended instead of upserting.
    captureSessionOutput.mockResolvedValue(THINKING_PANE);

    await checkForResponse(WT, 'claude');

    const sweepFrames = broadcastMessage.mock.calls.filter(
      ([, payload]) => (payload as { message?: ChatMessage }).message?.id === SWEPT_ROW.id
    );
    expect(sweepFrames).toHaveLength(1);
    expect(sweepFrames[0][0]).toBe('message_updated');
  });

  it('publishes nothing when the sweep stamped nothing', async () => {
    markPendingPromptsAsAnswered.mockImplementation(() => 0);
    captureSessionOutput.mockResolvedValue(THINKING_PANE);

    await checkForResponse(WT, 'claude');

    expect(updatedFrames()).toEqual([]);
  });

  it('keeps polling when the broadcast throws', async () => {
    // The rows are already stamped by the time the socket is touched; a socket
    // write that fails must not take the poll down with it.
    broadcastMessage.mockImplementation(() => {
      throw new Error('socket closed');
    });
    captureSessionOutput.mockResolvedValue(THINKING_PANE);

    await expect(checkForResponse(WT, 'claude')).resolves.toBe(false);
  });
});
