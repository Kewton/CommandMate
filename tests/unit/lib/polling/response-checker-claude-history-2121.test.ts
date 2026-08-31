/**
 * The screen scraper standing down for Claude (Issue #2121).
 *
 * Claude has no server to subscribe to, so the handover cannot be "is somebody
 * else connected?" the way #2041's was. It is "read the transcript now" — and
 * the only moment CommandMate knows a Claude turn is finished *and* is about to
 * write a row for it is this one, inside the poller's save path. This suite
 * drives the real `checkForResponse`, because the whole point is that wiring: a
 * test that called the reader directly would pass with the call site deleted.
 *
 * Two directions matter and both are asserted.
 *
 *  - **Recorded → the scrape is dropped.** Otherwise History shows the reply
 *    twice, once as the agent wrote it and once as the pane drew it, and the two
 *    are not byte-comparable so no content check could ever collapse them.
 *  - **Not recorded → the scrape is saved.** This is the fail-open the
 *    acceptance criteria name. A transcript that is missing, unreadable, or
 *    simply not written yet must cost nothing at all, because the pane is then
 *    the only record the reply has.
 *
 * What must *not* be suppressed either way is everything else the poller does on
 * the same tick — the push, the answered prompts, the session cursor. Gating
 * those would trade a duplicated reply for a phone that stops ringing.
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
const markPendingPromptsAsAnswered = vi.fn(() => 1);
vi.mock('@/lib/db', () => ({
  createMessage: (...a: [unknown, Record<string, unknown>]) => createMessage(...a),
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  updateSessionState: (...a: unknown[]) => updateSessionState(...a),
  getWorktreeById: () => ({ id: 'wt-2121', name: 'wt-2121', path: '/repos/wt-2121' }),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: (...a: unknown[]) => markPendingPromptsAsAnswered(...(a as [])),
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

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import {
  captureStructuredHistoryTurn,
  isStructuredHistoryWriterLive,
} from '@/lib/polling/structured-history-gate';

const WT = 'wt-2121';

/**
 * A finished claude turn on a 1000-row alternate-screen pane.
 *
 * Same shape as the #1268 / #1695 fixtures: transcript at the top, blank filler,
 * and the footer (separator / input box / separator / status bar) pinned to the
 * bottom. Extraction anchors on the footer, so a bare two-line transcript saves
 * nothing at all and every assertion below would pass vacuously.
 */
const SEPARATOR = '─'.repeat(40);
const REPLY_LINE = '⏺ CommandMate is a Git worktree management tool.';

function claudePane(head: readonly string[]): string {
  const tail = ['', SEPARATOR, '❯ ', SEPARATOR, '  ⏸ manual mode on · ? for shortcuts'];
  const filler = new Array(1000 - head.length - tail.length).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

const CLAUDE_PANE = claudePane(['❯ summarize the project', REPLY_LINE]);

/** The transcript path Claude prints, which `parseClaudeOutput` has always read. */
const PANE_LOG_PATH = '/home/me/.claude/projects/-repos-wt-2121/abc.jsonl';

/** The same pane, with the `📄 Session log:` line on it. */
const CLAUDE_PANE_WITH_LOG = claudePane([
  '❯ summarize the project',
  REPLY_LINE,
  `📄 Session log: ${PANE_LOG_PATH}`,
]);

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
  vi.mocked(isStructuredHistoryWriterLive).mockReturnValue(false);
  vi.mocked(captureStructuredHistoryTurn).mockResolvedValue(false);
  captureSessionOutput.mockResolvedValue(CLAUDE_PANE);
});

describe('with no transcript — the pre-#2121 behaviour, unchanged', () => {
  it('sanity: the scraper still saves the reply', async () => {
    // The premise every suppression assertion is measured against.
    expect(await checkForResponse(WT, 'claude')).toBe(true);
    expect(savedAssistantContents()).toHaveLength(1);
    expect(savedAssistantContents()[0]).toContain('Git worktree management tool');
  });

  it('writes the Markdown conversation log too', async () => {
    await checkForResponse(WT, 'claude');
    expect(recordClaudeConversation).toHaveBeenCalledTimes(1);
  });
});

describe('with a transcript the reader recorded', () => {
  beforeEach(() => {
    vi.mocked(captureStructuredHistoryTurn).mockResolvedValue(true);
  });

  it('saves no scraped assistant row at all', async () => {
    await checkForResponse(WT, 'claude');
    expect(savedAssistantContents()).toEqual([]);
  });

  it('writes no conversation log either', async () => {
    await checkForResponse(WT, 'claude');
    expect(recordClaudeConversation).not.toHaveBeenCalled();
  });

  it('still advances the session cursor, so the poller does not re-read forever', async () => {
    await checkForResponse(WT, 'claude');
    expect(updateSessionState).toHaveBeenCalled();
  });

  it('still marks pending prompts answered', async () => {
    await checkForResponse(WT, 'claude');
    expect(markPendingPromptsAsAnswered).toHaveBeenCalled();
  });

  it('still raises the completion push', async () => {
    // The failure this gate must not cause: a phone that stops being told the
    // agent finished. The transcript file has no push producer of its own.
    await checkForResponse(WT, 'claude');
    expect(notifyPushSubscribers).toHaveBeenCalledTimes(1);
    expect(notifyPushSubscribers.mock.calls[0][0]).toMatchObject({ kind: 'completion' });
  });
});

describe('what the reader is told to look at', () => {
  it('is this instance, not the tool in general', async () => {
    await checkForResponse(WT, 'claude', 'claude-3');
    expect(vi.mocked(captureStructuredHistoryTurn)).toHaveBeenCalledWith(
      WT,
      'claude',
      'claude-3',
      expect.objectContaining({ worktreePath: '/repos/wt-2121' })
    );
  });

  it('carries the transcript path the pane printed, when it printed one', async () => {
    captureSessionOutput.mockResolvedValue(CLAUDE_PANE_WITH_LOG);
    await checkForResponse(WT, 'claude');
    expect(vi.mocked(captureStructuredHistoryTurn)).toHaveBeenCalledWith(
      WT,
      'claude',
      undefined,
      expect.objectContaining({
        transcriptPathHint: PANE_LOG_PATH,
      })
    );
  });

  it('carries a null hint when the pane printed nothing', async () => {
    await checkForResponse(WT, 'claude');
    expect(vi.mocked(captureStructuredHistoryTurn).mock.calls[0][3].transcriptPathHint).toBeNull();
  });
});

describe('the other tools', () => {
  it.each(['codex', 'gemini', 'copilot'] as const)(
    'a %s turn is still recorded by the scraper',
    async (cliToolId) => {
      // The reader answers false for every tool but claude, so the poller must
      // still be the writer for them. Asserted through the whole path rather
      // than on the gate alone, because the failure mode is a suppressed save.
      stopPolling(WT, cliToolId);
      await checkForResponse(WT, cliToolId);
      expect(vi.mocked(captureStructuredHistoryTurn).mock.results.every((r) => r.value !== true)).toBe(
        true
      );
    }
  );
});
