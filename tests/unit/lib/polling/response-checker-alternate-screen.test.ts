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
import { findClaudeChromeStart } from '@/lib/detection/cli-patterns';

// ---------------------------------------------------------------------------
// Fixture: a faithful Claude alternate-screen pane.
// ---------------------------------------------------------------------------

const SEPARATOR = '─'.repeat(40);

const STATUS_BAR = '  ⏸ manual mode on · ? for shortcuts · ← for agents                       focus';

/**
 * The hint row Claude Code reserves directly above its input box, transcribed
 * from a live session. It rotates every few seconds while the conversation sits
 * idle and is blank much of the time — the rotation is what broke #1268's
 * content dedup (Issue #1289).
 */
const HINT_ROWS = [
  '                                                              ◉ xhigh · /effort',
  "  tmux detected · scroll with PgUp/PgDn · or add 'set -g mouse on' to ~/.tmux.conf for wheel scroll",
  "  tmux focus-events off · add 'set -g focus-events on' to ~/.tmux.conf and reattach for focus tracking",
  '',
];

/**
 * Build a Claude alternate-screen capture of exactly `paneHeight` lines.
 *
 * Mirrors the real structure observed via `tmux capture-pane` on a live Claude
 * session: the echoed user turn and the reply at the top, blank filler, then the
 * footer pinned to the bottom rows — hint row, separator, input box, separator,
 * status bar. The last line is non-blank, so extractResponse()'s trailing-blank
 * trim leaves totalLines === paneHeight — the saturation #1268 is about.
 *
 * `hint` and `inputBox` are the parts that actually move on a live pane, so they
 * are parameterised rather than frozen: a fixture that pins them to one value is
 * what let #1289 through.
 */
function claudePane(
  response: string,
  { hint = '', inputBox = '❯ ', paneHeight = 1000 }: { hint?: string; inputBox?: string; paneHeight?: number } = {},
): string {
  const head = [`❯ summarize the project`, ...response.split('\n')];
  const tail = [hint, SEPARATOR, inputBox, SEPARATOR, STATUS_BAR];
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

describe('Issue #1289: rotating footer must not defeat content dedup', () => {
  it('sanity: the rotating hint really does change the captured pane', () => {
    // Guards the premise this whole describe rests on. #1268's fixture pinned the
    // footer to one static value, so its dedup tests passed while the live poller
    // re-saved the same reply every tick. If these panes were identical the
    // rotation tests below would pass vacuously.
    const panes = HINT_ROWS.map(hint => claudePane(RESPONSE, { hint }));
    expect(new Set(panes).size).toBe(HINT_ROWS.length);
  });

  it('saves one message when the response is static but the hint row rotates', async () => {
    // The exact production sequence: the reply is finished and the transcript is
    // frozen, but Claude keeps cycling the hint row above its input box. Pre-fix
    // the hint reached the saved content, so the SHA-256 changed on every tick and
    // isDuplicateResponse() never fired — one message saved per poll.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    for (const hint of HINT_ROWS) {
      captureSessionOutput.mockResolvedValueOnce(claudePane(RESPONSE, { hint }));
    }

    const results: boolean[] = [];
    for (let i = 0; i < HINT_ROWS.length; i++) {
      results.push(await checkForResponse('wt-1', 'claude'));
    }

    expect(results).toEqual([true, false, false, false]);
    expect(savedAssistantContents()).toHaveLength(1);
  });

  it('keeps terminal chrome out of the saved response', async () => {
    // The hint row and status bar are not the assistant talking, so they must not
    // be stored at all — normalising the hash alone would still persist them.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    captureSessionOutput.mockResolvedValue(
      claudePane(RESPONSE, { hint: HINT_ROWS[0] }),
    );

    expect(await checkForResponse('wt-1', 'claude')).toBe(true);

    const [saved] = savedAssistantContents();
    expect(saved).toContain('CommandMate is a Git worktree management tool.');
    expect(saved).not.toContain('manual mode on');
    expect(saved).not.toContain('for shortcuts');
    expect(saved).not.toContain('for agents');
    expect(saved).not.toContain('◉ xhigh');
    expect(saved).not.toContain('/effort');
    expect(saved).not.toMatch(/─{10,}/);
  });

  it('does not save the startup screen as a reply while the message is still in the input box', async () => {
    // Between send() and Claude echoing the turn, the typed text sits in the
    // footer's input box and the transcript holds only the startup banner. That
    // "❯ …" in the input box has the same shape as a transcript echo, so pre-fix
    // it anchored extraction onto the footer and stored the status bar as a reply.
    getSessionState.mockReturnValue({ lastCapturedLine: 0, inProgressMessageId: null });
    const banner = [
      '',
      ' ▐▛███▜▌   Claude Code v2.1.211',
      '▝▜█████▛▘  Opus 4.8 (1M context) with xhigh effort · Claude Max',
      '  ▘▘ ▝▝    ~/share/work/github_kewton/CommandMate',
      '',
      ' ⚠ Your login expires in 5 days · run /login to renew',
    ];
    const tail = ['', SEPARATOR, '❯ summarize the project', SEPARATOR, STATUS_BAR];
    const filler = new Array(1000 - banner.length - tail.length).fill('');
    captureSessionOutput.mockResolvedValue([...banner, ...filler, ...tail].join('\n'));

    expect(await checkForResponse('wt-1', 'claude')).toBe(false);
    expect(savedAssistantContents()).toEqual([]);
  });

  it('still saves a long reply whose echoed turn has scrolled off the pane', async () => {
    // Guards the fix's blast radius. A reply long enough to fill the pane pushes
    // the "❯ summarize the project" echo off the top, leaving no anchor at all —
    // so "no echo ⇒ no response" would silently drop exactly the long replies and
    // reproduce #1268. Verified against a live 1200-line reply.
    getSessionState.mockReturnValue({ lastCapturedLine: 1000, inProgressMessageId: null });
    const body = Array.from({ length: 990 }, (_, i) => `  ${i + 1}`);
    const tail = ['', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
    captureSessionOutput.mockResolvedValue([...body, ...tail].join('\n'));

    expect(await checkForResponse('wt-1', 'claude')).toBe(true);

    const [saved] = savedAssistantContents();
    expect(saved).toContain('990');
    expect(saved).not.toContain('manual mode on');
  });
});

describe('Issue #1289: findClaudeChromeStart', () => {
  it('cuts from the reserved hint row through the status bar', () => {
    const lines = ['⏺ reply', '', HINT_ROWS[0], SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
    expect(findClaudeChromeStart(lines)).toBe(2);
  });

  it('cuts the same rows when the hint row is blank', () => {
    const lines = ['⏺ reply', '', '', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR];
    expect(findClaudeChromeStart(lines)).toBe(2);
  });

  it('handles a multi-row input box', () => {
    const lines = ['⏺ reply', '', SEPARATOR, '❯ line one', '  line two', SEPARATOR, STATUS_BAR];
    expect(findClaudeChromeStart(lines)).toBe(1);
  });

  it('reports no footer for a pane that has none', () => {
    expect(findClaudeChromeStart(['⏺ reply', 'more text'])).toBe(-1);
  });

  it('does not mistake a lone separator inside the transcript for a footer', () => {
    // A reply containing a horizontal rule must not be truncated at it.
    expect(findClaudeChromeStart(['⏺ reply', SEPARATOR, 'text after the rule'])).toBe(-1);
  });

  it('does not mistake reply text fenced by two rules for the input box', () => {
    // The footer is separator/❯ input/separator/status bar. A reply that fences
    // its own content in horizontal rules has the same separator spacing, so the
    // "❯" check is what keeps its tail from being swallowed.
    const lines = ['⏺ reply', SEPARATOR, 'fenced reply body', SEPARATOR, '❯ next message'];
    expect(findClaudeChromeStart(lines)).toBe(-1);
  });

  it('tolerates trailing blank rows below the status bar', () => {
    const lines = ['⏺ reply', '', SEPARATOR, '❯ ', SEPARATOR, STATUS_BAR, '', ''];
    expect(findClaudeChromeStart(lines)).toBe(1);
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
