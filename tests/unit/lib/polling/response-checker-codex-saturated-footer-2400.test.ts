/**
 * Issue #2400: a saturated codex pane must save the REPLY, not its status bar.
 *
 * ## What was measured
 *
 * On `mcbd-codex-commandagent-develop` (2026-09-07, `history_size 12683`, pane
 * 1000 rows) every assistant row the scrape path wrote looked like this:
 *
 * ```text
 * chat_messages | assistant | request_id NULL | 123 chars
 *   "gpt-6-astra xhigh · ~/share/work/github_kewton/CommandAgent-develop"
 * ```
 *
 * — codex's status bar, saved instead of the answer, once per turn, and the
 * chat surface rendered it as an assistant bubble. Because the row is identical
 * from turn to turn, `isDuplicateResponse` then locked on it and the pane could
 * not record anything at all.
 *
 * ## The mechanism
 *
 * 1. The window saturates (#1670), so `lastCapturedLine` stops being a position
 *    in the capture and `resolveExtractionStartIndex` switches to "the newest
 *    echoed user prompt", searched backwards from the bottom of the pane.
 * 2. codex had no chrome reader, so that search ran all the way to the last row
 *    and the newest `›` it met was the COMPOSER.
 * 3. Extraction began on the row after the composer: the status bar.
 *
 * Steps 2 and 3 are what this suite pins. Step 1 is #1670's, already covered by
 * `response-checker-capture-window-saturation.test.ts`, and this file re-uses its
 * shape deliberately: a real capture tail with reconstructed scrollback above it.
 *
 * ## The fixture
 *
 * `tests/fixtures/codex-live-2310/saturated-idle-tail.txt` is the last 60 rows
 * of an 11,000-row `tmux capture-pane -p -e -S -10000` taken on a genuinely
 * saturated pane — codex-cli 0.153.4, 200x1000, `history_size 11,025`, the
 * scrollback filled with `transcript row <n>` before codex was started in it.
 * The 9,940 rows this repository does not carry were that filler and are
 * reconstructed here; everything that decides the outcome — the echo, the reply,
 * the composer, the status bar, and the SGR attributes that tell them apart — is
 * the live capture, byte for byte.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { CACHE_MAX_CAPTURE_LINES, isCaptureWindowSaturated } from '@/lib/tmux/tmux-capture-cache';
import { stripAnsi } from '@/lib/detection/cli-patterns';

// ---------------------------------------------------------------------------
// Module boundary mocks (same set as the #1670 suite this file extends)
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
// The live tail, and the scrollback that made it saturate
// ---------------------------------------------------------------------------

const LIVE_2310 = join(__dirname, '../../../fixtures/codex-live-2310');
const TAIL = readFileSync(join(LIVE_2310, 'saturated-idle-tail.txt'), 'utf-8').split('\n');

/** The scrollback the pane was filled with before codex was started in it. */
const filler = (n: number): string[] =>
  Array.from({ length: n }, (_, i) => `transcript row ${i + 1}`);

/** The status bar that was being saved as the reply, and the composer above it. */
const STATUS_BAR_TEXT = 'gpt-6-astra default ·';
const COMPOSER_TEXT = 'Ask Codex to do anything';

/** The three rows codex actually answered with in the captured turn. */
const REPLY_ROWS = [
  'A worktree is a working directory for a Git repository.',
  'Each worktree can check out a different branch.',
  'Worktrees share repository history but keep files separate.',
] as const;

/**
 * A capture of exactly `windowLines` rows: reconstructed scrollback, then the
 * live tail. `body` replaces the reply text so consecutive turns differ.
 */
function pane(body?: string, windowLines: number = CACHE_MAX_CAPTURE_LINES): string {
  const tail = body
    ? TAIL.map(line => line.replace(REPLY_ROWS[0], body))
    : TAIL;
  return [...filler(windowLines - tail.length), ...tail].join('\n');
}

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant')
    .map(([, m]) => stripAnsi(String(m.content)));
}

function useLiveSessionState(initial: number): void {
  let lastCapturedLine = initial;
  getSessionState.mockImplementation(() => ({ lastCapturedLine, inProgressMessageId: null }));
  updateSessionState.mockImplementation((...args: unknown[]) => {
    lastCapturedLine = args[3] as number;
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'codex');
  isSessionRunning.mockResolvedValue(true);
});

// ---------------------------------------------------------------------------
// Premises
// ---------------------------------------------------------------------------

describe('[#2400] fixture premises', () => {
  it('the reconstructed pane really saturates the capture window', () => {
    const lines = pane().split('\n');

    expect(lines).toHaveLength(CACHE_MAX_CAPTURE_LINES);
    expect(isCaptureWindowSaturated(lines.length, CACHE_MAX_CAPTURE_LINES)).toBe(true);
    // Saturation is the precondition for the whole defect: without it codex
    // extraction starts at the line cursor and never consults the echo anchor.
    expect(extractResponse(pane(), CACHE_MAX_CAPTURE_LINES - 1, 'codex')?.captureWindowSaturated).toBe(true);
  });

  it('the tail carries the composer, the status bar and the reply', () => {
    const tail = TAIL.map(stripAnsi).join('\n');

    expect(tail).toContain(COMPOSER_TEXT);
    expect(tail).toContain(STATUS_BAR_TEXT);
    for (const row of REPLY_ROWS) expect(tail).toContain(row);
    // The capture is raw: the SGR attributes are what separate the composer's
    // `›` from the echo's, and a stripped fixture would make this suite vacuous.
    expect(TAIL.join('\n')).toContain('\x1b[');
  });
});

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------

describe('[#2400] a saturated codex pane saves the reply, not the status bar', () => {
  it('extracts the answer body', () => {
    const result = extractResponse(pane(), CACHE_MAX_CAPTURE_LINES - 1, 'codex');

    expect(result?.isComplete).toBe(true);
    const response = stripAnsi(result!.response);
    for (const row of REPLY_ROWS) expect(response).toContain(row);
  });

  it('the composer and the status bar are outside the saved response', () => {
    // The exact regression: pre-fix the response WAS the status bar, and nothing
    // else. Both halves are asserted because a fix that merely stopped at the
    // composer would leave the composer row itself in History (#1289's shape).
    const response = stripAnsi(extractResponse(pane(), CACHE_MAX_CAPTURE_LINES - 1, 'codex')!.response);

    expect(response).not.toContain(STATUS_BAR_TEXT);
    expect(response).not.toContain(COMPOSER_TEXT);
  });

  it('the echoed prompt and the scrollback above it are not in the response', () => {
    const response = stripAnsi(extractResponse(pane(), CACHE_MAX_CAPTURE_LINES - 1, 'codex')!.response);

    expect(response).not.toContain('transcript row');
    expect(response).not.toContain('Reply with exactly three short lines');
  });

  it('the saved assistant message is the reply', async () => {
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane());

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);

    const [saved] = savedAssistantContents();
    expect(saved).toContain(REPLY_ROWS[0]);
    expect(saved).not.toContain(STATUS_BAR_TEXT);
    // The reported row was 123 bytes of ANSI-bearing status bar. Anything that
    // short cannot be this three-line answer, so the length is a second,
    // independent reading of the same claim.
    expect(saved.length).toBeGreaterThan(120);
  });

  it('a footer-only assistant row is never produced', async () => {
    // The acceptance condition stated as its own test: whatever else changes,
    // the one thing that must never reach `chat_messages` again is a message
    // whose entire content is codex's `model · cwd` row.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane());

    await checkForResponse('wt-1', 'codex');

    for (const saved of savedAssistantContents()) {
      expect(saved.trim()).not.toMatch(/^gpt-\S+ \S+ · \S+$/);
    }
  });
});

// ---------------------------------------------------------------------------
// The lock the footer row caused
// ---------------------------------------------------------------------------

describe('[#2400] content dedup no longer locks on a constant row', () => {
  it('three consecutive turns are each saved', async () => {
    // The status bar is identical on every turn, so once it became the response
    // `isDuplicateResponse` refused everything that followed — the pane could
    // not record a reply again for the rest of the session. Different replies
    // must now produce different content, which is what unlocks it.
    useLiveSessionState(0);
    const bodies = ['first saturated reply', 'second saturated reply', 'third saturated reply'];

    for (const body of bodies) {
      stopPolling('wt-1', 'codex'); // each send() restarts polling → new cycle
      captureSessionOutput.mockResolvedValue(pane(body));
      expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    }

    const saved = savedAssistantContents();
    expect(saved).toHaveLength(3);
    for (const body of bodies) expect(saved.join('\n')).toContain(body);
  });

  it('still refuses to re-save the same finished screen on every tick', async () => {
    // Dedup is load-bearing without the line cursor (#1670), so the fix must not
    // buy turn-to-turn recording by disabling it.
    useLiveSessionState(CACHE_MAX_CAPTURE_LINES);
    captureSessionOutput.mockResolvedValue(pane());

    expect(await checkForResponse('wt-1', 'codex')).toBe(true);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);
    expect(await checkForResponse('wt-1', 'codex')).toBe(false);

    expect(savedAssistantContents()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// No regression below the window
// ---------------------------------------------------------------------------

describe('[#2400] the unsaturated path is unchanged', () => {
  it('a small codex pane extracts the same reply', () => {
    // Below the window codex extraction starts at the line cursor and never
    // consults the echo anchor, so this is the case the fix must leave alone.
    const small = pane(undefined, 300);
    const cursor = small.split('\n').findIndex(l => stripAnsi(l).startsWith('› Reply with exactly'));
    const result = extractResponse(small, cursor + 1, 'codex');

    expect(result?.captureWindowSaturated).toBe(false);
    const response = stripAnsi(result!.response);
    for (const row of REPLY_ROWS) expect(response).toContain(row);
    expect(response).not.toContain(STATUS_BAR_TEXT);
  });

  it('the line cursor still stops where the content stops', () => {
    // codex renders INLINE and repaints the composer band in place: the next
    // turn's transcript is printed over exactly the rows the composer occupies
    // in this capture. Before #2400 the extraction loop stopped on the
    // composer's `›` and wrote that index into `lineCount`; with the composer now
    // outside `contentEnd` the break cannot fire on it, so the cursor is pinned
    // to the content end explicitly. A cursor parked on `totalLines` would skip
    // those rows on the next poll and lose the head of the following turn.
    const small = pane(undefined, 300);
    const lines = small.split('\n');
    const composerRow = lines.findIndex(l => stripAnsi(l).startsWith('› Ask Codex'));
    const cursor = lines.findIndex(l => stripAnsi(l).startsWith('› Reply with exactly'));
    const result = extractResponse(small, cursor + 1, 'codex');

    expect(result?.lineCount).toBe(composerRow);
    expect(result!.lineCount).toBeLessThan(lines.length);
  });

  it('a pane whose chrome cannot be located still refuses the composer', () => {
    // Mutation injection on the second guard: strip the ANSI and delete the
    // status bar, and `findCodexChromeStart` has nothing left to read. The
    // anchor must still step over the composer rather than start extraction on
    // the row below it — which is where the pre-#2400 placeholder list used to
    // come in, and it no longer exists.
    const lines = pane().split('\n').map(stripAnsi).filter(l => !l.includes(STATUS_BAR_TEXT));
    const result = extractResponse(lines.join('\n'), CACHE_MAX_CAPTURE_LINES - 1, 'codex');

    const response = stripAnsi(result?.response ?? '');
    expect(response).not.toContain(COMPOSER_TEXT);
    for (const row of REPLY_ROWS) expect(response).toContain(row);
  });
});
