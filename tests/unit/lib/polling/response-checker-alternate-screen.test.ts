/**
 * Issue #1268: assistant responses must still be recorded once the captured
 * line count saturates at the tmux pane height.
 *
 * Claude Code v2 renders in the terminal's ALTERNATE SCREEN: tmux keeps no
 * scrollback for it (`history_size` 0, `alternate_on` 1), so `capture-pane`
 * always returns exactly `pane_height` lines and the trimmed line count is
 * pinned there from the very first render (Claude's status bar occupies the
 * bottom row). `session_states.last_captured_line` therefore saturates at the
 * pane height on the first save, after which the poller's line-count dedup
 * (`lineCount <= lastCapturedLine`) discarded every subsequent response —
 * History sat on "Waiting for response..." forever while the terminal showed
 * the reply.
 *
 * These tests drive the real checkForResponse() rather than re-implementing its
 * logic, because the pre-fix bug lived entirely in the gate between "response
 * extracted successfully" and "message written".
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';

// ---------------------------------------------------------------------------
// Module boundary mocks (tmux, DB, WS, push, logging side effects)
// ---------------------------------------------------------------------------

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

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({ recordClaudeConversation: vi.fn(async () => {}) }));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({ broadcastTerminalSnapshot: vi.fn(async () => {}) }));

import { checkForResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';

// ---------------------------------------------------------------------------
// Fixture: a faithful Claude alternate-screen pane.
// ---------------------------------------------------------------------------

const SEPARATOR = '─'.repeat(40);

/**
 * Build a Claude alternate-screen capture of exactly `paneHeight` lines.
 *
 * Mirrors the real structure observed via `tmux capture-pane` on a live Claude
 * session: the echoed user turn and the reply at the top, blank filler, then the
 * input box and status bar pinned to the bottom row. The last line is non-blank,
 * so extractResponse()'s trailing-blank trim leaves totalLines === paneHeight —
 * the saturation that this issue is about.
 */
function claudePane(response: string, paneHeight = 1000): string {
  const head = [`❯ summarize the project`, ...response.split('\n')];
  const tail = [SEPARATOR, '❯ ', SEPARATOR, '  ⏸ manual mode on · ← for agents'];
  const filler = new Array(Math.max(0, paneHeight - head.length - tail.length)).fill('');
  return [...head, ...filler, ...tail].join('\n');
}

const RESPONSE = '⏺ CommandMate is a Git worktree management tool.';

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant')
    .map(([, m]) => String(m.content));
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'claude'); // reset per-cycle content dedup cache
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #1268: alternate-screen line-count saturation', () => {
  it('sanity: the fixture really is saturated (totalLines === lastCapturedLine)', async () => {
    // Guards the premise. If Claude stops pinning content to the bottom row this
    // fixture stops modelling reality and the tests below would pass vacuously.
    const pane = claudePane(RESPONSE);
    const lines = pane.split('\n');
    expect(lines).toHaveLength(1000);
    expect(lines[lines.length - 1].trim()).not.toBe('');
  });

  it('records the assistant response even though lineCount === lastCapturedLine', async () => {
    // The exact production state: session_states.last_captured_line saturated at
    // the pane height. Pre-fix this returned false and saved nothing.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    captureSessionOutput.mockResolvedValue(claudePane(RESPONSE));

    const saved = await checkForResponse('wt-1', 'claude');

    expect(saved).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('CommandMate is a Git worktree management tool.');
  });

  it('does not re-save the same static screen on every poll tick', async () => {
    // Without a line-count cursor, dedup must come from content instead.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    captureSessionOutput.mockResolvedValue(claudePane(RESPONSE));

    expect(await checkForResponse('wt-1', 'claude')).toBe(true);
    expect(await checkForResponse('wt-1', 'claude')).toBe(false);
    expect(await checkForResponse('wt-1', 'claude')).toBe(false);

    expect(savedAssistantContents()).toHaveLength(1);
  });

  it('records an identical response again in a later turn', async () => {
    // Content dedup must be per polling cycle, not permanent: a repeated
    // "完了しました。" is a real reply, and dropping it would reproduce #1268.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    captureSessionOutput.mockResolvedValue(claudePane(RESPONSE));

    expect(await checkForResponse('wt-1', 'claude')).toBe(true);
    expect(await checkForResponse('wt-1', 'claude')).toBe(false);

    stopPolling('wt-1', 'claude'); // next send() restarts polling → new cycle

    expect(await checkForResponse('wt-1', 'claude')).toBe(true);
    expect(savedAssistantContents()).toHaveLength(2);
  });

  it('still records responses for scrollback tools (codex)', async () => {
    // Codex renders inline (alternate_on=0) with real scrollback, so its buffer
    // genuinely grows past lastCapturedLine. Guards the untouched path.
    const codexPane = [
      ...new Array(40).fill('older scrollback'),
      '⏺ Codex reply body',
      '› ',
    ].join('\n');
    getSessionState.mockReturnValue({ lastCapturedLine: 40, inProgressMessageId: null });
    captureSessionOutput.mockResolvedValue(codexPane);

    const saved = await checkForResponse('wt-1', 'codex' as CLIToolType);

    expect(saved).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('Codex reply body');
  });
});

describe('Issue #1268: usesAlternateScreen tool trait', () => {
  // Behavioural coverage cannot pin this down on the codex side: for scrollback
  // tools extraction starts AT lastCapturedLine, so a non-empty response always
  // implies lineCount > lastCapturedLine and the gate can never fire with
  // content. The classification itself is therefore asserted directly.
  it.each<[CLIToolType, boolean]>([
    ['claude', true], // alternate_on=1 since Claude Code v2 — the #1268 regression
    ['opencode', true],
    ['copilot', true],
    ['codex', false],
    ['gemini', false],
    ['vibe-local', false],
    ['antigravity', false],
  ])('classifies %s as alternate-screen=%s', (tool, expected) => {
    expect(usesAlternateScreen(tool)).toBe(expected);
  });
});
