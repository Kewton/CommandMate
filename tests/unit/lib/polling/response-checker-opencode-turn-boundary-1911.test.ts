/**
 * Issue #1911: what opencode saves as an assistant reply must be THIS turn, and
 * only this turn.
 *
 * opencode renders in the alternate screen, so one `capture-pane` holds the tail
 * of the whole conversation plus the chrome pinned to the bottom of the pane.
 * Nothing told the poller where the current turn started or stopped, and the
 * three defects reported in #1911 are that one missing boundary seen from three
 * sides:
 *
 *  1. the echoed user prompt and the bottom chrome were saved as part of the
 *     reply. Extraction anchored on the SECOND-TO-LAST `▣ Build` row, which
 *     belongs to the PREVIOUS turn — and on the first turn of a session, where
 *     there is no second row, on line 0. The reported save was
 *     `Reply with exactly the word: pong2 / pong2 / <cwd> 6.4K (1%) · $ctrl+p`.
 *  2. the previous turn's `▣ … · 2.3s` completed the NEW turn. #1893 made the
 *     duration mandatory, but a finished previous turn carries one, so the first
 *     poll after a send saved the previous answer and stopped polling.
 *  3. the Layer-2 accumulator was written for opencode and never read, so a turn
 *     longer than the pane was saved without its head.
 *
 * Frames are the live 80x200 captures of opencode 1.18.21 that #1883/#1893
 * recorded (`lib/detection/fixtures/opencode-live-*`), plus synthetic panes built
 * to the same measured geometry for the sequences no single capture can hold (a
 * turn in flight, a turn taller than the pane).
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

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

import { checkForResponse, extractResponse } from '@/lib/polling/response-checker';
import { getPollerKey, stopPolling } from '@/lib/polling/response-poller-core';
import { initTuiAccumulator, getAccumulatedContent } from '@/lib/tui-accumulator';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import {
  isOpenCodeComplete,
  resolveOpenCodeTurnRegion,
  sliceOpenCodeTurn,
} from '@/lib/response-extractor';
import {
  stripAnsi,
  findOpenCodeChromeStart,
  findOpenCodeUserEchoEnd,
  OPENCODE_TURN_COMPLETE_PATTERN,
} from '@/lib/detection/cli-patterns';

// ---------------------------------------------------------------------------
// Live frames
// ---------------------------------------------------------------------------

function frame(dir: string, name: string): string {
  return fs.readFileSync(
    path.resolve(__dirname, '../../lib/detection/fixtures', dir, `${name}.txt`),
    'utf-8',
  );
}

/** What the poller ends up writing to `chat_messages.content` for a frame. */
function savedReplyFor(raw: string): string {
  const result = extractResponse(raw, 0, 'opencode');
  expect(result?.isComplete, 'frame is not a completed turn').toBe(true);
  return cleanOpenCodeResponse(result!.response);
}

// ---------------------------------------------------------------------------
// Synthetic panes, built to the geometry the live captures measure
// ---------------------------------------------------------------------------

/** `OPENCODE_PANE_HEIGHT`; what production actually captures. */
const PANE_HEIGHT = 200;

/**
 * The composer box and the footer under its `╹▀▀▀` border, transcribed row for
 * row from `opencode-live-1893/turn-complete-short.txt` (ANSI removed, geometry
 * kept). The cwd wraps over three rows and only the first of them carries any
 * signature at all — which is why the boundary has to be structural.
 */
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

/** The same chrome while the model is generating (`opencode-live-1883/turn-running.txt`). */
const RUNNING_CHROME = [
  '  ┃                                                                           ',
  '  ┃                                                                           ',
  '  ┃                                                                           ',
  '  ┃  Build · GPT-5.6 Luna GitHub Copilot                                      ',
  `  ╹${'▀'.repeat(75)}`,
  '   ⬝⬝⬝⬝⬝⬝⬝⬝  esc interrupt                  6.3K (1%) · $0.00  ctrl+p commands',
];

/** The three-row box opencode echoes a submitted message into, plus its blank separator. */
function userEcho(text: string): string[] {
  return ['  ┃', `  ┃  ${text}`, '  ┃', ''];
}

function openCodePane(transcript: string[], { running = false } = {}): string {
  const chrome = running ? RUNNING_CHROME : IDLE_CHROME;
  const capacity = PANE_HEIGHT - chrome.length;
  // A pane taller than the transcript pads in the middle; a transcript taller
  // than the pane loses its HEAD, exactly as the alternate screen does.
  const body = transcript.slice(Math.max(0, transcript.length - capacity));
  const filler = new Array(capacity - body.length).fill('');
  return [...body, ...filler, ...chrome].join('\n');
}

// ---------------------------------------------------------------------------

const POLLER_KEY = getPollerKey('wt-1', 'opencode');

function savedAssistantContents(): string[] {
  return createMessage.mock.calls
    .filter(([, m]) => m.role === 'assistant')
    .map(([, m]) => String(m.content));
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'opencode'); // resets accumulator + per-cycle content dedup
  isSessionRunning.mockResolvedValue(true);
  getSessionState.mockReturnValue({ lastCapturedLine: PANE_HEIGHT, inProgressMessageId: null });
});

// ===========================================================================
// Structural anchors
// ===========================================================================

describe('Issue #1911: the turn region is read from the pane structure', () => {
  it('finds the composer box and the footer under it in a live idle frame', () => {
    const lines = stripAnsi(frame('opencode-live-1893', 'turn-complete-short')).split('\n');
    const chromeStart = findOpenCodeChromeStart(lines);

    // Rows 190-193 are the composer's gutter, 194 its `╹▀▀▀` border, 195-197 the
    // wrapped cwd footer. Everything from 190 down is chrome.
    expect(chromeStart).toBe(190);
    expect(lines[chromeStart]).toMatch(/^\s*┃/);
    expect(lines.slice(chromeStart).join('\n')).toContain('6.4K (1%) · $ctrl+p');
    expect(lines.slice(0, chromeStart).join('\n')).not.toContain('6.4K (1%)');
  });

  it('treats the permission dialog as chrome even though it has no border row', () => {
    // The dialog draws OVER the composer and runs to the last row of the pane, so
    // there is no `╹▀▀▀` to walk up from — the bottom-anchored gutter run is.
    const lines = stripAnsi(frame('opencode-live-1893', 'permission-bash')).split('\n');
    expect(findOpenCodeChromeStart(lines)).toBe(190);
    expect(lines.slice(190).join('\n')).toContain('Allow once');
  });

  it('finds the composer on the boot screen, where it is not bottom-anchored', () => {
    // opencode centres the composer under its ASCII banner while the footer stays
    // pinned to the bottom of the pane, ~95 blank rows below it. A search windowed
    // to the footer's own height misses the border completely.
    const lines = stripAnsi(frame('opencode-live-1883', 'boot-idle')).split('\n');
    expect(findOpenCodeChromeStart(lines)).toBe(99);
    expect(lines[99]).toMatch(/^\s*┃/);
  });

  it('anchors on the newest echoed prompt, not on the previous turn', () => {
    const lines = stripAnsi(frame('opencode-live-1893', 'turn-complete-short')).split('\n');
    const region = resolveOpenCodeTurnRegion(lines);

    // Two turns are on screen. The newest echo is `Reply with exactly: hi` at
    // rows 9-11; the turn starts on the row after its box.
    expect(lines[10]).toContain('Reply with exactly: hi');
    expect(region.echoEnd).toBe(11);
    expect(findOpenCodeUserEchoEnd(lines, region.chromeStart)).toBe(11);
    // The composer's own gutter rows are below `chromeStart`, so they are never
    // mistaken for an echoed prompt — pass -1 and the newest "echo" becomes the
    // composer's `Build · GPT-5.6 Luna GitHub Copilot` row instead.
    expect(findOpenCodeUserEchoEnd(lines, -1)).toBeGreaterThan(region.chromeStart);
    expect(region.start).toBe(12);
    expect(region.headTruncated).toBe(false);

    const turn = lines.slice(region.start, region.end).join('\n');
    expect(turn).toContain('hi');
    expect(turn).not.toContain('Reply with exactly: hi');
    expect(turn).not.toContain('Run the shell command: ls -la'); // the previous turn
  });

  it('reports a truncated head when no echo is left on screen', () => {
    const pane = openCodePane([
      ...new Array(220).fill('     a very long answer that outgrew the pane'),
      '     ▣  Build · GPT-5.6 Luna · 42.0s',
    ]);
    const region = resolveOpenCodeTurnRegion(stripAnsi(pane).split('\n'));

    expect(region.echoEnd).toBe(-1);
    expect(region.start).toBe(0);
    expect(region.headTruncated).toBe(true);
  });
});

// ===========================================================================
// Defect 1: echo + chrome contamination
// ===========================================================================

describe('Issue #1911 defect 1: the echo and the bottom chrome stay out of the reply', () => {
  it('saves only the answer for a live two-turn frame', () => {
    // The reported shape, on a real capture: the reply was
    // "<echoed prompt> / <answer> / <cwd wrapped over three rows>".
    expect(savedReplyFor(frame('opencode-live-1893', 'turn-complete-short'))).toBe('hi');
  });

  it('drops every row the reported save contained', () => {
    const saved = savedReplyFor(frame('opencode-live-1893', 'turn-complete-short'));

    expect(saved).not.toContain('Reply with exactly: hi');            // this turn's echo
    expect(saved).not.toContain('Run the shell command: ls -la');     // the previous turn
    expect(saved).not.toContain('6.4K (1%)');                         // footer status cell
    expect(saved).not.toContain('/private/tmp/claude-501');           // footer cwd, row 1
    expect(saved).not.toContain('ocprobe1911');                       // footer cwd, last row
    expect(saved).not.toContain('GitHub Copilot');                    // composer model row
  });

  it('keeps a multi-line answer intact, including its thinking row', () => {
    // The other side of the same cut: trimming must not eat the reply. This frame's
    // turn is a haiku plus a four-row explanation.
    const saved = savedReplyFor(frame('opencode-live-1883', 'turn-complete'));

    expect(saved).toContain('+ Thought: Structuring a haiku · 870ms');
    expect(saved).toContain('Windows bloom in dark');
    expect(saved).toContain('tmux processes continuing quietly in the background.');
    expect(saved.split('\n')).toHaveLength(8);

    // ...and must not drag in the FIRST turn of the same frame.
    expect(saved).not.toContain('Reply with exactly: ok');
    expect(saved).not.toContain('Write a haiku about tmux');
  });

  it('still removes everything the cleaner removed before', () => {
    // Non-vacuity for the other direction: a green here that came from "we stopped
    // deleting things" would be a regression, not a fix.
    const saved = savedReplyFor(frame('opencode-live-1883', 'turn-complete'));

    expect(saved).not.toMatch(/▣\s+Build/);          // the finished-turn marker itself
    expect(saved).not.toContain('esc interrupt');
    expect(saved).not.toContain('Ask anything...');
    expect(saved).not.toMatch(/^[┃│╹▀─]+$/m);        // bare TUI separators
  });

  it('saves the answer on the FIRST turn of a session, where there is no previous marker', () => {
    // The pre-fix anchor needed a SECOND `▣ Build` row to exist. On turn one it
    // did not, extraction fell back to line 0, and the whole pane became the reply.
    const pane = openCodePane([
      ...userEcho('Reply with exactly the word: pong2'),
      '     pong2',
      '',
      '     ▣  Build · GPT-5.6 Luna · 1.4s',
    ]);

    expect(savedReplyFor(pane)).toBe('pong2');
  });
});

describe('Issue #1911: the footer status cell is also removed by pattern', () => {
  it('drops the signed footer row from a fragment that has no chrome boundary', () => {
    // The secondary net. `findOpenCodeChromeStart` needs a whole pane; a caller
    // holding a fragment has no boundary to cut on, and the footer's first row is
    // the only one of the four that carries a signature.
    const fragment = [
      'pong2',
      '/private/tmp/claude-501/-Users-maenokota-share-    6.4K (1%) · $ctrl+p',
    ].join('\n');

    expect(cleanOpenCodeResponse(fragment)).toBe('pong2');
  });

  it('leaves prose that merely mentions a percentage alone', () => {
    // The cell is matched by its full shape (`<size> (<n>%) · $`), not by "there
    // is a percent sign on this row" — a reply is allowed to talk about disk usage.
    const prose = 'The disk is 80% full and the cache holds 6.4K entries.';
    expect(cleanOpenCodeResponse(prose)).toBe(prose);
  });
});

// ===========================================================================
// Defect 2: the previous turn's marker
// ===========================================================================

describe("Issue #1911 defect 2: the previous turn's marker does not complete this one", () => {
  /** A finished turn, then a fresh prompt whose answer has not started yet. */
  const AWAITING_ANSWER = openCodePane([
    ...userEcho('Reply with exactly: hi'),
    '     hi',
    '',
    '     ▣  Build · GPT-5.6 Luna · 2.3s',
    '',
    ...userEcho('Now reply with exactly: pong2'),
  ]);

  it('sanity: the frame really does carry a duration-carrying marker', () => {
    // The premise. #1893 made the duration mandatory, so if this frame had none
    // the tests below would pass for #1893's reason instead of this one's.
    expect(OPENCODE_TURN_COMPLETE_PATTERN.test(stripAnsi(AWAITING_ANSWER))).toBe(true);
    expect(stripAnsi(AWAITING_ANSWER)).not.toContain('esc interrupt');
  });

  it('refuses to call the frame complete while the new turn is unanswered', () => {
    expect(isOpenCodeComplete(stripAnsi(AWAITING_ANSWER))).toBe(false);
    expect(extractResponse(AWAITING_ANSWER, 0, 'opencode')?.isComplete).not.toBe(true);
  });

  it('does not save the previous answer as the new one, and keeps polling', async () => {
    // The reported consequence: the previous reply was written against the new
    // turn AND `stopPolling` ran, so the real answer was never recorded at all.
    captureSessionOutput.mockResolvedValue(AWAITING_ANSWER);

    expect(await checkForResponse('wt-1', 'opencode')).toBe(false);
    expect(savedAssistantContents()).toHaveLength(0);
  });

  it('completes as soon as the answer lands under the new echo (mutation-injected)', () => {
    // Non-vacuity: the ONLY difference is the marker moving below the newest echo.
    // Without this the test above would pass for any frame at all.
    const answered = openCodePane([
      ...userEcho('Reply with exactly: hi'),
      '     hi',
      '',
      '     ▣  Build · GPT-5.6 Luna · 2.3s',
      '',
      ...userEcho('Now reply with exactly: pong2'),
      '     pong2',
      '',
      '     ▣  Build · GPT-5.6 Luna · 1.1s',
    ]);

    expect(isOpenCodeComplete(stripAnsi(answered))).toBe(true);
    expect(savedReplyFor(answered)).toBe('pong2');
  });

  it('is what rejects the frame — removing the new echo brings the marker back (mutation-injected)', () => {
    // The inverse mutation, on the SAME pane: delete only the newly echoed prompt
    // and the previous turn's marker is the newest thing on screen again, which is
    // precisely the pre-#1911 reading.
    const withoutNewEcho = openCodePane([
      ...userEcho('Reply with exactly: hi'),
      '     hi',
      '',
      '     ▣  Build · GPT-5.6 Luna · 2.3s',
    ]);

    expect(isOpenCodeComplete(stripAnsi(withoutNewEcho))).toBe(true);
  });
});

// ===========================================================================
// Defect 3: the accumulator
// ===========================================================================

describe('Issue #1911 defect 3: a turn taller than the pane keeps its head', () => {
  const ANSWER = Array.from({ length: 250 }, (_, i) => `     line ${String(i + 1).padStart(3, '0')} of the long answer`);

  /** Poll 1: the turn has started, the echo is still on screen, the model is working. */
  const FIRST_POLL = openCodePane(
    [...userEcho('Write a very long answer'), ...ANSWER.slice(0, 180)],
    { running: true },
  );

  /** Poll 2: the pane has scrolled past the echo and the turn has finished. */
  const LAST_POLL = openCodePane([
    ...ANSWER.slice(170),
    '',
    '     ▣  Build · GPT-5.6 Luna · 31.4s',
  ]);

  it('sanity: the final frame really has lost the head of its own answer', () => {
    // The premise. If the pane still held `line 001` the accumulator would be
    // unnecessary and the test below would pass vacuously.
    expect(stripAnsi(LAST_POLL)).not.toContain('line 001');
    expect(stripAnsi(LAST_POLL)).toContain('line 250');
    expect(resolveOpenCodeTurnRegion(stripAnsi(LAST_POLL).split('\n')).headTruncated).toBe(true);
  });

  it('accumulates the turn region only, never the echo or the chrome', () => {
    // The accumulator is fed `sliceOpenCodeTurn` rather than the raw pane, so what
    // it stores can be used as a response source without re-introducing defect 1.
    const slice = stripAnsi(sliceOpenCodeTurn(FIRST_POLL));

    expect(slice).toContain('line 001');
    expect(slice).not.toContain('Write a very long answer'); // the echo
    expect(slice).not.toContain('GitHub Copilot');           // the composer model row
    expect(slice).not.toContain('esc interrupt');            // the footer
  });

  it('saves the head that scrolled away', async () => {
    initTuiAccumulator(POLLER_KEY);

    captureSessionOutput.mockResolvedValueOnce(FIRST_POLL);
    expect(await checkForResponse('wt-1', 'opencode')).toBe(false);
    expect(getAccumulatedContent(POLLER_KEY)).toContain('line 001');

    captureSessionOutput.mockResolvedValueOnce(LAST_POLL);
    expect(await checkForResponse('wt-1', 'opencode')).toBe(true);

    const saved = savedAssistantContents();
    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain('line 001'); // recovered from the accumulator
    expect(saved[0]).toContain('line 180'); // the overlap between the two polls
    expect(saved[0]).toContain('line 250'); // the tail, from the final frame
    expect(saved[0]).not.toContain('Write a very long answer');
    expect(saved[0]).not.toContain('6.4K (1%)');
  });

  it('ignores the accumulator while the echo is still on screen', () => {
    // Non-vacuity for the `turnHeadTruncated` guard, and the reason this is not
    // copilot's unconditional `accumulated || response`: opencode rewrites rows in
    // place while it works, every rewrite defeats the overlap check, and the
    // accumulator re-appends the lines above it. Preferring it for a turn the pane
    // still holds whole would duplicate content `result.response` has exactly.
    const running = openCodePane(
      [...userEcho('Say something'), '     + Thought: working · 12ms', '', '     answer line A'],
      { running: true },
    );
    const finished = openCodePane([
      ...userEcho('Say something'),
      '     + Thought: working · 579ms',
      '',
      '     answer line A',
      '     answer line B',
      '',
      '     ▣  Build · GPT-5.6 Luna · 2.0s',
    ]);

    return (async () => {
      initTuiAccumulator(POLLER_KEY);

      captureSessionOutput.mockResolvedValueOnce(running);
      await checkForResponse('wt-1', 'opencode');

      // The accumulator really is holding a duplicate by now — that is the hazard.
      captureSessionOutput.mockResolvedValueOnce(finished);
      expect(await checkForResponse('wt-1', 'opencode')).toBe(true);

      const saved = savedAssistantContents();
      expect(saved).toHaveLength(1);
      expect(saved[0].match(/answer line A/g)).toHaveLength(1);
      expect(saved[0]).not.toContain('· 12ms'); // the stale in-place row
      expect(saved[0]).toBe('+ Thought: working · 579ms\nanswer line A\nanswer line B');
    })();
  });
});
