/**
 * The scraper standing down while a human holds the pane (Issue #2317, Phase D).
 *
 * `commandmate attach --live` hands a claude session's window to the terminal
 * looking at it, so the pane stops being the 1000-row canvas every extraction
 * rule in `response-checker` was measured against and becomes 44 rows of
 * somebody's terminal, hard-wrapped to their width. Saving that as the agent's
 * reply would put a fraction of the answer into History and there would be no
 * way to tell afterwards.
 *
 * Three things are asserted, and the ORDER of the first two is the whole design:
 *
 *  1. the transcript reader still RUNS while delegated — it is a write, not a
 *     query, and it is the moment claude's own file becomes a History row. An
 *     `||` that short-circuited it would drop the reply along with the scrape;
 *  2. the pane's copy is dropped on top of that, so nothing is saved twice;
 *  3. on the release edge the session cursor is reset, because a
 *     `last_captured_line` recorded against the small frame indexes into a pane
 *     that no longer exists.
 *
 * @vitest-environment node
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const isSessionRunning = vi.fn<(...a: unknown[]) => Promise<boolean>>();
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
  isSessionRunning: (...a: unknown[]) => isSessionRunning(...a),
}));

const createMessage = vi.fn((_db: unknown, m: Record<string, unknown>) => ({ id: 'msg-1', ...m }));
const getSessionState = vi.fn();
const updateSessionState = vi.fn();
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  updateSessionState: (...a: unknown[]) => updateSessionState(...a),
  getWorktreeById: () => ({ id: 'wt-2317', name: 'wt-2317', path: '/repos/wt-2317' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
const broadcastMessage = vi.fn();
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: (...a: unknown[]) => broadcastMessage(...a) }));
const notifyPushSubscribers = vi.fn(async (_payload: Record<string, unknown>) => {});
vi.mock('@/lib/push', () => ({
  notifyPushSubscribers: (payload: Record<string, unknown>) => notifyPushSubscribers(payload),
}));
const recordClaudeConversation = vi.fn(async () => {});
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: (...a: unknown[]) => recordClaudeConversation(...(a as [])),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));
vi.mock('@/lib/polling/structured-history-gate', () => ({
  isStructuredHistoryWriterLive: vi.fn(() => false),
  captureStructuredHistoryTurn: vi.fn(async () => false),
}));

const probeGeometryDelegation = vi.fn(async (_s: string) => ({
  delegated: false,
  released: false,
}));
vi.mock('@/lib/tmux/geometry-delegation', () => ({
  probeGeometryDelegation: (s: string) => probeGeometryDelegation(s),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { captureStructuredHistoryTurn } from '@/lib/polling/structured-history-gate';
import { resolveSessionName } from '@/lib/cli-tools/session-name';

const WT = 'wt-2317';

/**
 * A finished claude turn on a 1000-row alternate-screen pane.
 *
 * Same shape as the #2121 fixture: transcript at the top, blank filler, and the
 * footer (separator / input box / separator / status bar) pinned to the bottom.
 * Extraction anchors on that footer, so a bare two-line transcript would save
 * nothing and every assertion below would pass vacuously.
 */
const SEPARATOR = '─'.repeat(40);
const REPLY_LINE = '⏺ CommandMate is a Git worktree management tool.';

function claudePane(head: readonly string[]): string {
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

const CLAUDE_PANE = claudePane(['❯ summarize the project', REPLY_LINE]);

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant' && m.messageType === 'normal')
    .map(([, m]) => String(m.content));
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling(WT, 'claude');
  isSessionRunning.mockResolvedValue(true);
  getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
  vi.mocked(captureStructuredHistoryTurn).mockResolvedValue(false);
  probeGeometryDelegation.mockResolvedValue({ delegated: false, released: false });
  captureSessionOutput.mockResolvedValue(CLAUDE_PANE);
});

describe('not delegated — nothing about the poller changes', () => {
  it('sanity: the scraper saves the reply exactly as it did before #2317', async () => {
    // The premise every suppression assertion below is measured against. Without
    // it, a delegated run saving nothing would prove nothing.
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(savedAssistantContents()).toHaveLength(1);
    expect(savedAssistantContents()[0]).toContain('Git worktree management tool');
    expect(recordClaudeConversation).toHaveBeenCalledTimes(1);
  });

  it('asks about the session the agent actually runs in', async () => {
    await checkForResponse(WT, 'claude');
    expect(probeGeometryDelegation).toHaveBeenCalledWith(resolveSessionName('claude', WT));
  });

  it('asks nothing at all for a tool --live cannot delegate', async () => {
    // One tmux round-trip per poll per session, for a question with a single
    // possible answer, is the cost this guard exists to avoid.
    await checkForResponse(WT, 'codex');
    expect(probeGeometryDelegation).not.toHaveBeenCalled();
  });
});

describe('delegated — the pane is somebody else\'s terminal', () => {
  beforeEach(() => {
    probeGeometryDelegation.mockResolvedValue({ delegated: true, released: false });
  });

  it('saves no assistant row scraped off the small frame', async () => {
    await checkForResponse(WT, 'claude');
    expect(savedAssistantContents()).toEqual([]);
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('writes no Markdown conversation log from it either', async () => {
    await checkForResponse(WT, 'claude');
    expect(recordClaudeConversation).not.toHaveBeenCalled();
  });

  it('STILL runs the transcript reader, so History keeps the reply', async () => {
    // The ordering the design turns on: `captureStructuredHistoryTurn` is a
    // WRITE. Short-circuiting it on the delegation flag would suppress the
    // scrape and the real record together, and the turn would vanish.
    vi.mocked(captureStructuredHistoryTurn).mockResolvedValue(true);
    await checkForResponse(WT, 'claude');
    expect(captureStructuredHistoryTurn).toHaveBeenCalledTimes(1);
    expect(savedAssistantContents()).toEqual([]);
  });

  it('does not suppress the completion push', async () => {
    // The half that is easy to get wrong: gating the whole poll would trade a
    // truncated reply for a phone that stops ringing.
    await checkForResponse(WT, 'claude');
    expect(notifyPushSubscribers).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'completion' }),
    );
  });
});

describe('the release edge', () => {
  it('resets the session cursor exactly once, before the state is read', async () => {
    probeGeometryDelegation.mockResolvedValue({ delegated: false, released: true });

    await checkForResponse(WT, 'claude');

    // Zero is the only value that cannot be wrong in either direction: a cursor
    // left too low re-saves the turn, one left too high suppresses every future
    // one.
    expect(updateSessionState).toHaveBeenCalledWith({}, WT, 'claude', 0, 'claude');
    expect(updateSessionState.mock.calls[0]).toEqual([{}, WT, 'claude', 0, 'claude']);
  });

  it('does not reset while the delegation is still in force', async () => {
    probeGeometryDelegation.mockResolvedValue({ delegated: true, released: false });
    await checkForResponse(WT, 'claude');
    expect(updateSessionState.mock.calls.some((call) => call[3] === 0)).toBe(false);
  });
});
