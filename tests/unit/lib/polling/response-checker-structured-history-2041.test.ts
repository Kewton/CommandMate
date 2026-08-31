/**
 * The screen scraper standing down for opencode (Issue #2041).
 *
 * Since #1763 CommandMate holds an SSE connection to opencode's own server, and
 * since this Issue that connection carries the reply's Markdown source. The
 * poller must not save the pane's rendering of the same turn on top of it —
 * History would show the answer twice, once as the agent wrote it and once
 * hard-wrapped to 200 columns with the `┃ ` gutter cleaned back off.
 *
 * What must **not** be suppressed is everything else the poller does on the same
 * tick. That is the half of this that is easy to get wrong: gating the whole
 * save path would trade a duplicated reply for a lost push notification and a
 * prompt row nobody wrote.
 *
 * The pane geometry is the one #1911 measured (200 rows, the composer box and
 * wrapped-cwd footer transcribed from `opencode-live-1893`).
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
  getWorktreeById: () => ({ id: 'wt-1', name: 'wt-1' }),
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
  // Issue #2121: the pull-mode half of the same gate. Stubbed false here so
  // these assertions keep measuring the push-mode (opencode) behaviour they were
  // written for; the Claude side has its own suite.
  captureStructuredHistoryTurn: vi.fn(async () => false),
}));

import { checkForResponse } from '@/lib/polling/response-checker';
import { getPollerKey, stopPolling } from '@/lib/polling/response-poller-core';
import { isStructuredHistoryWriterLive } from '@/lib/polling/structured-history-gate';

/** `OPENCODE_PANE_HEIGHT`; what production actually captures. */
const PANE_HEIGHT = 200;

/** The idle composer + wrapped-cwd footer, from `opencode-live-1893` (#1911). */
const IDLE_CHROME = [
  '  ┃                                                                           ',
  '  ┃                                                                           ',
  '  ┃                                                                           ',
  '  ┃  Build · GPT-5.6 Luna GitHub Copilot                                      ',
  `  ╹${'▀'.repeat(75)}`,
  '   /private/tmp/claude-501/-Users-maenokota-share-    6.4K (1%) · $ctrl+p ',
  '   work-github-kewton-commandmate-issue-1911/ae404cbd-             commands',
  '   600b-47b1-8082-4f46afc848b9/scratchpad/ocprobe1911',
];

/** The three-row box opencode echoes a submitted message into. */
function userEcho(text: string): string[] {
  return ['  ┃', `  ┃  ${text}`, '  ┃', ''];
}

function openCodePane(transcript: string[]): string {
  const capacity = PANE_HEIGHT - IDLE_CHROME.length;
  const body = transcript.slice(Math.max(0, transcript.length - capacity));
  const filler = new Array(capacity - body.length).fill('');
  return [...body, ...filler, ...IDLE_CHROME].join('\n');
}

/** A finished opencode turn whose reply is long enough to be saved. */
const FINISHED_TURN = openCodePane([
  ...userEcho('Explain deterministic builds'),
  '     Deterministic build outputs matter because the same source and the same',
  '     environment produce byte-identical artifacts, which is what makes a',
  '     rebuild a check rather than a hope.',
  '',
  '     ▣  Build · GPT-5.6 Luna · 3.1s',
]);

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant' && m.messageType === 'normal')
    .map(([, m]) => String(m.content));
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'opencode');
  isSessionRunning.mockResolvedValue(true);
  getSessionState.mockReturnValue({ lastCapturedLine: PANE_HEIGHT, inProgressMessageId: null });
  vi.mocked(isStructuredHistoryWriterLive).mockReturnValue(false);
  captureSessionOutput.mockResolvedValue(FINISHED_TURN);
});

describe('with no live subscription — the pre-#2041 behaviour', () => {
  it('sanity: the scraper still saves the reply', () => {
    // The premise every suppression assertion below is measured against. If this
    // frame produced no save at all, those assertions would pass vacuously.
    return checkForResponse('wt-1', 'opencode').then((saved) => {
      expect(saved).toBe(true);
      expect(savedAssistantContents()).toHaveLength(1);
      expect(savedAssistantContents()[0]).toContain('Deterministic build outputs matter');
    });
  });

  it('writes the Markdown conversation log too', async () => {
    await checkForResponse('wt-1', 'opencode');
    expect(recordClaudeConversation).toHaveBeenCalledTimes(1);
  });
});

describe('with a live subscription — the structured writer owns the turn', () => {
  beforeEach(() => {
    vi.mocked(isStructuredHistoryWriterLive).mockReturnValue(true);
  });

  it('saves no assistant row at all', async () => {
    await checkForResponse('wt-1', 'opencode');
    expect(savedAssistantContents()).toEqual([]);
    expect(broadcastMessage).not.toHaveBeenCalled();
  });

  it('writes no conversation log either', async () => {
    await checkForResponse('wt-1', 'opencode');
    expect(recordClaudeConversation).not.toHaveBeenCalled();
  });

  it('is asked about this instance, not about the tool in general', async () => {
    await checkForResponse('wt-1', 'opencode', 'opencode-3');
    expect(vi.mocked(isStructuredHistoryWriterLive)).toHaveBeenCalledWith(
      'wt-1',
      'opencode',
      'opencode-3'
    );
  });

  it('still advances the session cursor, so the poller does not re-read forever', async () => {
    await checkForResponse('wt-1', 'opencode');
    expect(updateSessionState).toHaveBeenCalled();
  });

  it('still marks pending prompts answered', async () => {
    // A dialog the operator answered at the terminal is retired by the poller
    // seeing the turn finish. Nothing on the event stream duplicates that.
    await checkForResponse('wt-1', 'opencode');
    expect(markPendingPromptsAsAnswered).toHaveBeenCalled();
  });

  it('still raises the completion push', async () => {
    // The failure this gate must not cause: a phone that stops being told the
    // agent finished. The event stream has no push producer of its own.
    await checkForResponse('wt-1', 'opencode');
    expect(notifyPushSubscribers).toHaveBeenCalledTimes(1);
    expect(notifyPushSubscribers.mock.calls[0][0]).toMatchObject({ kind: 'completion' });
  });
});

describe('every other tool', () => {
  it.each(['claude', 'codex', 'gemini', 'copilot'] as const)(
    '%s is never asked, because it has no server',
    async (cliToolId) => {
      // The gate reads the tool first, so a stale `true` cannot reach a tool
      // whose only record of a turn is the pane.
      vi.mocked(isStructuredHistoryWriterLive).mockImplementation((_wt, tool) => tool === 'opencode');
      await checkForResponse('wt-1', cliToolId);
      expect(vi.mocked(isStructuredHistoryWriterLive).mock.results.every((r) => r.value === false)).toBe(
        true
      );
    }
  );
});
