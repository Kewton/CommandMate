/**
 * Issue #1670: assistant responses must still be recorded once the CAPTURE
 * WINDOW saturates on an inline-rendering (scrollback) CLI tool.
 *
 * Every capture this app takes is a sliding window over the tail of the pane:
 * `captureSessionOutput()` asks tmux for `-S -CACHE_MAX_CAPTURE_LINES` and
 * `sliceOutput()` keeps the last `requestedLines` rows. While the pane holds
 * fewer rows than that window the returned line count grows with the transcript,
 * which is what makes `session_states.last_captured_line` usable as a "how far
 * have I read" cursor. Once the pane outgrows the window the count is pinned at
 * the window size for good and the window merely slides — so the poller's
 * `lineCount <= lastCapturedLine` gate became permanently true and every later
 * reply was dropped with `already-saved-up-to-line`. Observed on the live
 * `mcbd-codex-commandagent-develop` session (history_size 10908 vs a 10000-line
 * window): History froze at 10:02:22 JST while the terminal kept scrolling.
 *
 * This is #1268's defect reached from the other side. #1268 covered tools whose
 * count saturates at PANE HEIGHT because they render in the alternate screen and
 * keep no scrollback; those are excluded from the cursor by tool identity
 * (`usesAlternateScreen`). The tools here do keep scrollback — the cursor is
 * genuinely useful for them, right up until the buffer outgrows the window — so
 * the exclusion has to be a runtime condition, not a tool trait.
 *
 * The tests drive the real checkForResponse() rather than re-implementing the
 * gate, because the defect lived entirely between "response extracted
 * successfully" and "message written".
 *
 * NOTE on the fixtures: `• Ran` never appears in the last 20 rows. Codex's
 * thinking pattern matches that past-tense marker, so a fixture with it in the
 * tail fails completion detection for a reason that has nothing to do with
 * saturation (Issue #1671).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usesAlternateScreen, type CLIToolType } from '@/lib/cli-tools/types';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import { TMUX_HISTORY_LIMIT, TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';

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
vi.mock('@/lib/tasks/task-transition-service', () => ({ applyEventToActiveTask: vi.fn() }));

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';

// ---------------------------------------------------------------------------
// Fixtures: inline-rendering panes, one per scrollback tool.
//
// Shape transcribed from a live `tmux capture-pane` of
// mcbd-codex-commandagent-develop: older transcript, the echoed user turn, the
// reply, then the tool's footer (rule / input box / status bar) pinned at the
// bottom with a non-blank last row — so the trailing-blank trim leaves
// totalLines at the full window width, which is the saturation itself.
// ---------------------------------------------------------------------------

/** Scrollback that has already slid out from under the recorded cursor. */
const FILLER = '  transcript row that has already scrolled past the window';

/** CLI tools that render inline and therefore accumulate real tmux scrollback. */
const INLINE_TOOLS: CLIToolType[] = ['codex', 'gemini', 'vibe-local', 'antigravity'];

interface Turn {
  /** The pane's echo of what the user sent — the anchor extraction falls back to. */
  echo: string;
  /** The assistant reply rows. */
  body: string[];
  /** Footer rows pinned below the reply; the last one must be non-blank. */
  footer: string[];
}

const TURN_BUILDERS: Record<string, (body: string) => Turn> = {
  codex: (body) => ({
    echo: '› update the saturation guard',
    body: [`• ${body}`],
    footer: [
      '',
      '─'.repeat(120),
      '',
      '› Find and fix a bug in @filename',
      '',
      '  gpt-5.6-sol xhigh · ~/share/work/github_kewton/CommandMate',
    ],
  }),
  gemini: (body) => ({
    echo: '> update the saturation guard',
    body: [`✦ ${body}`],
    footer: ['', '❯ ', '  gemini-2.5-pro  (main*)'],
  }),
  'vibe-local': (body) => ({
    echo: '❯ update the saturation guard',
    body: [`  ${body}`],
    footer: ['', 'ctx:42% ❯', '✦ Ready   ESC: stop'],
  }),
  antigravity: (body) => ({
    echo: '> update the saturation guard',
    body: [`  ${body}`],
    footer: ['', '─'.repeat(80), '>', '? for shortcuts   gemini-3-pro'],
  }),
};

/**
 * Build a capture of exactly `totalLines` rows for `tool`, ending on the footer.
 *
 * The turn is placed at the bottom and older scrollback is padded above it, which
 * is exactly how a saturated window looks: the reply is present, and everything
 * the recorded cursor used to point at has slid off the top.
 */
function pane(tool: CLIToolType, body: string, totalLines: number): string {
  const turn = TURN_BUILDERS[tool](body);
  const rows = [turn.echo, '', ...turn.body, ...turn.footer];
  const filler = new Array(Math.max(0, totalLines - rows.length)).fill(FILLER);
  return [...filler, ...rows].join('\n');
}

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant')
    .map(([, m]) => String(m.content));
}

/**
 * Wire getSessionState/updateSessionState into a single mutable row so the poller
 * reads back exactly what it wrote. Without this, a test could keep feeding a
 * hand-picked cursor and never notice that the product re-pins its own state.
 */
function useLiveSessionState(initial: number): { current: () => number } {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
  return { current: () => lastCapturedLine };
}

beforeEach(() => {
  vi.clearAllMocks();
  for (const tool of INLINE_TOOLS) stopPolling('wt-1', tool);
  isSessionRunning.mockResolvedValue(true);
});

describe('Issue #1670: fixture premises', () => {
  // These guard the premises the rest of the file rests on. If a fixture stops
  // being exactly one window wide, or stops being classified as a scrollback
  // tool, the saturation tests below would pass without exercising saturation.
  it.each(INLINE_TOOLS)('%s fixture fills the capture window and ends non-blank', (tool) => {
    const lines = pane(tool, 'reply body', CACHE_MAX_CAPTURE_LINES).split('\n');

    expect(lines).toHaveLength(CACHE_MAX_CAPTURE_LINES);
    expect(lines[lines.length - 1].trim()).not.toBe('');
    expect(isCaptureWindowSaturated(lines.length, CACHE_MAX_CAPTURE_LINES)).toBe(true);
  });

  it.each(INLINE_TOOLS)('%s renders inline, so #1268 never excluded it from the cursor', (tool) => {
    // The whole point: these tools legitimately use the line-count cursor, which
    // is why the fix has to be a runtime condition rather than a tool trait.
    expect(usesAlternateScreen(tool)).toBe(false);
  });

  it.each(INLINE_TOOLS)('%s extraction reports the window as saturated', (tool) => {
    const result = extractResponse(
      pane(tool, 'reply body', CACHE_MAX_CAPTURE_LINES),
      CACHE_MAX_CAPTURE_LINES - 1,
      tool,
    );

    expect(result?.isComplete).toBe(true);
    expect(result?.captureWindowSaturated).toBe(true);
  });
});

describe('Issue #1670: saturated inline sessions keep recording replies', () => {
  it.each(INLINE_TOOLS)('%s saves every turn once the window is pinned', async (tool) => {
    // Three consecutive turns against a permanently full window, with the poller's
    // own session_states writes fed back in. Pre-fix, turn 1 pinned the cursor at
    // the window and turns 2-3 were dropped with already-saved-up-to-line.
    const state = useLiveSessionState(0);
    const bodies = ['first reply', 'second reply', 'third reply'];

    for (const body of bodies) {
      stopPolling('wt-1', tool); // each send() restarts polling → new cycle
      captureSessionOutput.mockResolvedValue(pane(tool, body, CACHE_MAX_CAPTURE_LINES));
      expect(await checkForResponse('wt-1', tool)).toBe(true);
    }

    const saved = savedAssistantContents();
    expect(saved).toHaveLength(3);
    for (const body of bodies) {
      expect(saved.join('\n')).toContain(body);
    }
    // The cursor really did pin — the tests above are not passing because the
    // buffer kept growing under them.
    expect(state.current()).toBeGreaterThanOrEqual(CACHE_MAX_CAPTURE_LINES - 10);
  });

  it.each(INLINE_TOOLS)('%s recovers from a session_states row already pinned at the window', async (tool) => {
    // The stuck state as found in production, with no DB repair applied first.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane(tool, 'reply after the pane saturated', CACHE_MAX_CAPTURE_LINES));

    expect(await checkForResponse('wt-1', tool)).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('reply after the pane saturated');
  });

  it('codex recovers from the exact observed cursor (last_captured_line = 9999)', async () => {
    // The value read off the live session in the report — 9999, one short of the
    // 10000-line window, written by the prompt path's totalLines bookkeeping.
    // It was fixed by hand in production; that hand-fix is what must stop being
    // necessary.
    useLiveSessionState(9999);
    captureSessionOutput.mockResolvedValue(pane('codex', 'reply the operator never saw saved', CACHE_MAX_CAPTURE_LINES));

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('reply the operator never saw saved');
  });

  it('codex extracts the whole turn, not a tail fragment, when the window is saturated', async () => {
    // Anchoring is the other half of the fix: with the cursor disabled but
    // extraction still starting AT lastCapturedLine, the poller would save the
    // last row or two of a long reply instead of the reply.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES - 1);
    const turn = TURN_BUILDERS.codex('');
    const body = Array.from({ length: 400 }, (_, i) => `• reply row ${i + 1}`);
    const rows = [turn.echo, '', ...body, ...turn.footer];
    const filler = new Array(CACHE_MAX_CAPTURE_LINES - rows.length).fill(FILLER);
    captureSessionOutput.mockResolvedValue([...filler, ...rows].join('\n'));

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);

    const [saved] = savedAssistantContents();
    expect(saved).toContain('reply row 1');
    expect(saved).toContain('reply row 400');
    expect(saved).not.toContain(FILLER);
  });
});

describe('Issue #1670: dedup still holds without the cursor', () => {
  it('does not re-save the same finished screen on every poll tick', async () => {
    // Disabling the cursor removes what used to suppress re-saves, so content
    // dedup has to take over — otherwise the fix would append the same reply
    // every 2 s, which is worse than the bug.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane('codex', 'static finished reply', CACHE_MAX_CAPTURE_LINES));

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);

    expect(savedAssistantContents()).toHaveLength(1);
  });

  it('records an identical reply again in a later turn', async () => {
    // Content dedup is per polling cycle, not permanent: a repeated "完了しました。"
    // is a real reply and dropping it would reproduce the reported symptom.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane('codex', '完了しました。', CACHE_MAX_CAPTURE_LINES));

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);

    stopPolling('wt-1', 'codex'); // next send() restarts polling → new cycle

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(savedAssistantContents()).toHaveLength(2);
  });
});

describe('Issue #1670: the cursor survives below the window', () => {
  // The fix must not simply retire the line-count cursor. Below the window the
  // cursor is correct AND load-bearing: it is the only thing stopping a re-save
  // on the very next tick. These two run the same 300-row fixture and differ in
  // nothing but where the cursor sits.
  const SMALL_PANE = 300;
  const unsaturated = pane('codex', 'already recorded reply', SMALL_PANE);
  const echoIndex = unsaturated.split('\n').findIndex(line => line.startsWith('› update'));

  it('codex records the reply while the cursor is still behind it', async () => {
    useLiveSessionState(echoIndex + 1);
    captureSessionOutput.mockResolvedValue(unsaturated);

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(savedAssistantContents().join('\n')).toContain('already recorded reply');
  });

  it('codex refuses the same screen once its own cursor has caught up', async () => {
    const probe = extractResponse(unsaturated, echoIndex + 1, 'codex');
    expect(probe?.captureWindowSaturated).toBe(false);

    useLiveSessionState(probe!.lineCount); // what the save above writes back
    captureSessionOutput.mockResolvedValue(unsaturated);

    expect(await checkForResponse('wt-1', 'codex')).toBe(false);
    expect(savedAssistantContents()).toEqual([]);
    // Pins WHICH gate refused: the line-count gates return before touching
    // session_states, whereas the empty-response and content-dedup exits all
    // write it. Without this the test would also pass if the cursor were dead
    // and the fixture merely extracted to nothing.
    expect(updateSessionState).not.toHaveBeenCalled();
  });
});

describe('Issue #1670: a bigger window is not the fix', () => {
  // The acceptance condition that rules out the symptomatic patch. Saturation is
  // caused by the buffer no longer growing, so it recurs at whatever ceiling is
  // chosen — including TMUX_HISTORY_LIMIT, the deepest one tmux will ever hold.
  it.each([
    ['a small window', 200],
    ['CACHE_MAX_CAPTURE_LINES', CACHE_MAX_CAPTURE_LINES],
    ['TMUX_HISTORY_LIMIT', TMUX_HISTORY_LIMIT],
  ])('recurs and is handled at %s', (_label, windowLines) => {
    const saturated = extractResponse(
      pane('codex', 'reply at the ceiling', windowLines),
      windowLines - 1,
      'codex',
      windowLines,
    );

    expect(saturated?.captureWindowSaturated).toBe(true);
    expect(saturated?.isComplete).toBe(true);
    expect(saturated?.response).toContain('reply at the ceiling');
    expect(saturated?.response).not.toContain(FILLER);
  });

  it.each([
    ['a small window', 200],
    ['CACHE_MAX_CAPTURE_LINES', CACHE_MAX_CAPTURE_LINES],
    ['TMUX_HISTORY_LIMIT', TMUX_HISTORY_LIMIT],
  ])('leaves the cursor alone one row below %s', (_label, windowLines) => {
    const belowCeiling = extractResponse(
      pane('codex', 'reply below the ceiling', windowLines - 1),
      0,
      'codex',
      windowLines,
    );

    expect(belowCeiling?.captureWindowSaturated).toBe(false);
  });
});

describe('Issue #1670: no regression on the #1268 alternate-screen path', () => {
  it('a full-height Claude pane is never reported as window-saturated', () => {
    // Claude's pane is TUI_PANE_HEIGHT rows and its count saturates there, an
    // order of magnitude below the capture window. If the new flag could fire for
    // it, the #1268 branch would be reached through a second, untested route.
    expect(TUI_PANE_HEIGHT).toBeLessThan(CACHE_MAX_CAPTURE_LINES);

    const claudePane = [
      '❯ summarize the project',
      '⏺ CommandMate is a Git worktree management tool.',
      ...new Array(TUI_PANE_HEIGHT - 7).fill(''),
      '',
      '─'.repeat(40),
      '❯ ',
      '─'.repeat(40),
      '  ⏸ manual mode on · ? for shortcuts',
    ].join('\n');

    const result = extractResponse(claudePane, TUI_PANE_HEIGHT, 'claude');

    expect(claudePane.split('\n')).toHaveLength(TUI_PANE_HEIGHT);
    expect(result?.captureWindowSaturated).toBe(false);
  });
});
