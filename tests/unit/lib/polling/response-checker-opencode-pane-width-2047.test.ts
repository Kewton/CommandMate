/**
 * Issue #2047: the #1911 turn-boundary path, re-run at 120 and 200 columns.
 *
 * #1911 taught `response-checker` where an opencode turn starts and stops by
 * reading the pane's STRUCTURE — `findOpenCodeChromeStart` walks up from the
 * bottom to the composer box, `findOpenCodeUserEchoEnd` walks down to the newest
 * echoed prompt, and everything between is the turn. Structure read off a pane
 * is exactly the kind of thing a width change can move, which is why #2047 lists
 * this path alongside the four detection suites.
 *
 * The frames are `tests/fixtures/opencode-live-2047`: one live opencode 1.18.22
 * session captured at 80, 120 and 200 columns by resizing the window between
 * captures, so the only variable is the width.
 *
 * Result, and the reason `OPENCODE_PANE_WIDTH` is still 80:
 *
 * - at **120** every anchor is still FOUND and the saved reply holds the same
 *   glyphs. The row numbers move — opencode's chrome is two rows shorter once
 *   the cwd footer stops wrapping — which is a fact about the layout, and the
 *   reason #1911 made these anchors structural instead of fixed offsets;
 * - at **200** opencode's right-hand sidebar shares rows with the transcript, and
 *   `extractResponse` saves it — a turn that produces no reply at 80 and 120
 *   comes back as `8,501 tokens / $0.00 spent / LSP / LSPs are disabled`.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Module boundary mocks — the same seams `response-checker-opencode-turn-
// boundary-1911.test.ts` cuts, trimmed to what `extractResponse` touches.
// ---------------------------------------------------------------------------

vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: vi.fn(),
  isSessionRunning: vi.fn(),
}));

vi.mock('@/lib/db', () => ({
  createMessage: vi.fn(),
  getSessionState: vi.fn(),
  updateSessionState: vi.fn(),
  getWorktreeById: vi.fn(() => ({ id: 'wt-1', name: 'wt-1' })),
  clearInProgressMessageId: vi.fn(),
  markPendingPromptsAsAnswered: vi.fn(() => 0),
}));

vi.mock('@/lib/db/db-instance', () => ({ getDbInstance: () => ({}) }));
vi.mock('@/lib/ws-server', () => ({ broadcastMessage: vi.fn() }));
vi.mock('@/lib/push', () => ({ notifyPushSubscribers: vi.fn(async () => {}) }));
vi.mock('@/lib/conversation-logger', () => ({
  recordClaudeConversation: vi.fn(async () => {}),
}));
vi.mock('@/lib/realtime/terminal-broadcast', () => ({
  broadcastTerminalSnapshot: vi.fn(async () => {}),
}));

import { extractResponse } from '@/lib/polling/response-checker';
import { stopPolling } from '@/lib/polling/response-poller-core';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import { resolveOpenCodeTurnRegion, isOpenCodeComplete } from '@/lib/response-extractor';
import {
  stripAnsi,
  findOpenCodeChromeStart,
  findOpenCodeUserEchoEnd,
} from '@/lib/detection/cli-patterns';

const FIXTURE_DIR = path.resolve(__dirname, '../../../fixtures/opencode-live-2047');

const WIDTHS = [80, 120, 200] as const;
type Width = (typeof WIDTHS)[number];

function frame(width: Width, name: string): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `w${width}`, `${name}.txt`), 'utf-8');
}

/** What the poller would write to `chat_messages.content` for this frame. */
function savedReply(raw: string): string | null {
  const result = extractResponse(raw, 0, 'opencode');
  if (!result?.isComplete) return null;
  return cleanOpenCodeResponse(result.response);
}

beforeEach(() => {
  vi.clearAllMocks();
  stopPolling('wt-1', 'opencode');
});

describe('Issue #2047: the #1911 structural anchors survive 120 columns', () => {
  it.each(['turn-complete', 'numbered-answer', 'phrase-in-response'])(
    'still finds a well-formed turn region for %s at every width',
    (name) => {
      // The anchors are STRUCTURAL, so what has to hold at every width is that
      // they are found and bound a sane region — not that they land on the same
      // row number. They do not, and for a reason worth recording rather than
      // asserting away: opencode's chrome is two rows SHORTER at >=120 columns
      // because the wrapped cwd footer stops needing three rows, and the echoed
      // prompt above it un-wraps as the pane grows. The rows move; the structure
      // does not.
      for (const width of WIDTHS) {
        const lines = stripAnsi(frame(width, name)).split('\n');
        const chromeStart = findOpenCodeChromeStart(lines);
        const echoEnd = findOpenCodeUserEchoEnd(lines, chromeStart);
        const region = resolveOpenCodeTurnRegion(lines);

        expect(chromeStart, `w${width}/${name} lost the composer box`).toBeGreaterThan(0);
        expect(chromeStart, `w${width}/${name} put the chrome off the pane`).toBeLessThan(
          lines.length
        );
        expect(echoEnd, `w${width}/${name} lost the echoed prompt`).toBeGreaterThanOrEqual(0);
        expect(echoEnd).toBeLessThan(chromeStart);
        expect(region.start).toBeLessThan(region.end);
        expect(region.headTruncated).toBe(false);
      }
    }
  );

  it('records where the chrome boundary actually moves to', () => {
    // Measured, and pinned so a future reader does not mistake the row shift for
    // a bug: the cwd footer needs three rows at 80 columns and one at 120+, so
    // the composer box starts two rows lower once the path stops wrapping. This
    // is also why `findOpenCodeChromeStart` had to be structural in #1911 rather
    // than a fixed offset from the bottom of the pane.
    const chromeStartAt = (width: Width) =>
      findOpenCodeChromeStart(stripAnsi(frame(width, 'turn-complete')).split('\n'));

    expect(chromeStartAt(80)).toBe(190);
    expect(chromeStartAt(120)).toBe(192);
    expect(chromeStartAt(200)).toBe(192);
  });

  it('agrees on whether the turn is finished, at every width', () => {
    for (const name of ['turn-complete', 'numbered-answer', 'double-esc-interrupted']) {
      const verdicts = WIDTHS.map((w) => isOpenCodeComplete(stripAnsi(frame(w, name))));
      expect(new Set(verdicts).size, `${name} disagreed across widths`).toBe(1);
    }
    // And the values are the ones #1893/#1894 pinned: a duration finishes a turn,
    // `· interrupted` does not.
    expect(isOpenCodeComplete(stripAnsi(frame(120, 'turn-complete')))).toBe(true);
    expect(isOpenCodeComplete(stripAnsi(frame(120, 'double-esc-interrupted')))).toBe(false);
  });

  it('saves the same reply at 80 and 120', () => {
    for (const name of ['turn-complete', 'numbered-answer']) {
      const narrow = savedReply(frame(80, name));
      const wide = savedReply(frame(120, name));
      expect(narrow, `${name} did not extract at 80`).not.toBeNull();
      // Whitespace removed: opencode hard-wraps the reply body to the pane, so
      // the line breaks legitimately differ while the glyphs must not.
      expect(wide?.replace(/\s+/g, '')).toBe(narrow?.replace(/\s+/g, ''));
    }
    expect(savedReply(frame(120, 'turn-complete'))).toContain('pong2047');
  });
});

describe('Issue #2047: at 200 columns the poller saves the sidebar', () => {
  it('turns an empty reply into sidebar chrome', () => {
    // The single most consequential finding of #2047, and the one that needs
    // nothing from the user: opencode's sidebar occupies the same ROWS as the
    // transcript at >=121 columns, and #1911's region is a row range.
    expect(savedReply(frame(80, 'phrase-in-response'))).toBe('');
    expect(savedReply(frame(120, 'phrase-in-response'))).toBe('');

    const wide = savedReply(frame(200, 'phrase-in-response'));
    expect(wide).not.toBe('');
    expect(wide).toMatch(/tokens/);
    expect(wide).toMatch(/LSPs are disabled/);
  });

  it('does NOT reach a reply whose rows sit below the sidebar', () => {
    // The leak is a row overlap, not a blanket contamination, and saying so is
    // what keeps this Issue's claim honest. opencode draws the sidebar from the
    // top of the pane; `numbered-answer`'s turn region starts at row 26, below
    // the last sidebar row, so its saved reply is clean at 200 too.
    //
    // Which means the damage is a function of where the turn happens to sit —
    // i.e. unpredictable per turn, not per configuration. That is worse than a
    // consistent break, not better, and it is the argument for keeping the pane
    // below OPENCODE_SIDEBAR_MIN_WIDTH rather than teaching the extractor to
    // trim columns it cannot measure.
    const narrow = savedReply(frame(80, 'numbered-answer'));
    const wide = savedReply(frame(200, 'numbered-answer'));

    expect(narrow).toContain('1. Yes');
    expect(wide?.replace(/\s+/g, '')).toBe(narrow?.replace(/\s+/g, ''));
    expect(wide).not.toMatch(/tokens|% used|spent|LSPs are disabled/);
  });
});
