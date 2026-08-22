/**
 * Issue #1910: `commandmate capture <id>` printed one empty byte for every
 * alternate-screen session that had taken a single turn.
 *
 * `buildCurrentOutput` publishes `content` as "everything the poller has not
 * saved yet", produced by slicing the fresh capture at
 * `session_states.last_captured_line`. That slice is only meaningful while the
 * stored number is a POSITION IN THE CAPTURE, and for the alternate-screen tools
 * it never is: tmux keeps them no scrollback, so `capture-pane` returns exactly
 * `pane_height` rows forever (1000 for copilot / claude, 200 for opencode) and
 * the poller — which calls `updateSessionState` unconditionally; only its DEDUP
 * comparison is gated on the tool (`response-checker.ts`) — stores that pane
 * height after the first reply. The next capture is the same height, so the
 * slice starts past the last row and `content` collapses to `''`.
 *
 * #1670 had already met this from the other side and guarded it, but with the
 * wrong condition for these tools: capture-WINDOW saturation, which needs 10000
 * rows and therefore never fires on a 1000-row pane. The fix restates the rule
 * as `capturedLineCountIsCursor(cliToolId, captureWindowSaturated)` — the count
 * is a cursor only when NEITHER pinning mechanism applies (#1268 and #1670).
 *
 * Both sides are pinned here on purpose. A test that only asserted "the
 * alternate-screen tools get the whole frame" is satisfied by deleting the slice
 * altogether, which would silently turn `content` into a duplicate of
 * `fullOutput` for codex/gemini/vibe-local/antigravity — tools whose cursor is
 * genuinely useful — and every `wait` stall check reading `content` with it.
 *
 * The copilot frame is the live 200x1000 `capture-pane -e` already in the tree
 * from #1885, not a synthetic one: the defect is a property of the real pane
 * geometry, and `PRE_FIX_SLICE_IS_EMPTY` below proves this fixture reproduces it.
 *
 * @vitest-environment node
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import type Database from 'better-sqlite3';

// ---------------------------------------------------------------------------
// Module boundary mocks (tmux capture, DB, auto-yes state)
// ---------------------------------------------------------------------------

const captureSessionOutput = vi.fn<(...a: unknown[]) => Promise<string>>();
const getSessionState = vi.fn<(...a: unknown[]) => unknown>();

vi.mock('@/lib/db', () => ({
  getSessionState: (...a: unknown[]) => getSessionState(...a),
  createMessage: vi.fn(() => ({ id: 'msg-1' })),
}));
vi.mock('@/lib/cli-tools/manager', () => ({
  CLIToolManager: {
    getInstance: () => ({
      getTool: () => ({ isRunning: vi.fn().mockResolvedValue(true) }),
    }),
  },
}));
vi.mock('@/lib/session/cli-session', () => ({
  captureSessionOutput: (...a: unknown[]) => captureSessionOutput(...a),
}));
vi.mock('@/lib/polling/auto-yes-manager', () => ({
  getAutoYesState: vi.fn(() => undefined),
  getLastServerResponseTimestamp: vi.fn(() => null),
  isPollerActive: vi.fn(() => true),
  // Faithful enough that two tools in one file never share a latch key.
  buildCompositeKey: (worktreeId: string, cliToolId: string, instanceId?: string) =>
    !instanceId || instanceId === cliToolId
      ? `${worktreeId}:${cliToolId}`
      : `${worktreeId}:${cliToolId}:${instanceId}`,
}));

import { buildCurrentOutput } from '@/lib/session/current-output-builder';
import {
  CLI_TOOL_IDS,
  capturedLineCountIsCursor,
  usesAlternateScreen,
  type CLIToolType,
} from '@/lib/cli-tools/types';
import { TUI_PANE_HEIGHT } from '@/config/tmux-pane-config';
import { OPENCODE_PANE_HEIGHT } from '@/lib/cli-tools/opencode';
import { STATUS_CAPTURE_LINES } from '@/config/status-capture-config';
import { CACHE_MAX_CAPTURE_LINES } from '@/lib/tmux/tmux-capture-cache';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const COPILOT_FRAME = fs.readFileSync(
  path.resolve(__dirname, '../lib/detection/fixtures/copilot-live-1885/turn-complete.txt'),
  'utf-8',
);

/** The capture window `buildCurrentOutput` effectively reads through. */
const EFFECTIVE_WINDOW = Math.min(STATUS_CAPTURE_LINES, CACHE_MAX_CAPTURE_LINES);

/** Pane height each alternate-screen tool is pinned to (see tmux-pane-config). */
const PANE_HEIGHT: Partial<Record<CLIToolType, number>> = {
  claude: TUI_PANE_HEIGHT,
  copilot: TUI_PANE_HEIGHT,
  opencode: OPENCODE_PANE_HEIGHT,
};

const ALT_SCREEN_TOOLS = CLI_TOOL_IDS.filter(usesAlternateScreen);
const SCROLLBACK_TOOLS = CLI_TOOL_IDS.filter((tool) => !usesAlternateScreen(tool));

/**
 * What `response-checker` stores into `last_captured_line` after a turn: the
 * captured row count with trailing blank rows trimmed (`extractResponse`).
 */
function pollerCursorFor(frame: string): number {
  const rows = frame.split('\n');
  let n = rows.length;
  while (n > 0 && rows[n - 1].trim() === '') n--;
  return n;
}

/** A pane-shaped frame: a marked first row, padding, a marked non-blank last row. */
function buildFrame(rows: number, tag: string): string {
  const lines = Array<string>(rows).fill('');
  lines[0] = `${tag} HEAD ROW`;
  lines[Math.floor(rows / 2)] = `${tag} MIDDLE ROW`;
  lines[rows - 1] = `${tag} TAIL ROW`;
  return lines.join('\n');
}

async function build(
  cliToolId: CLIToolType,
  frame: string,
  lastCapturedLine: number,
) {
  captureSessionOutput.mockResolvedValue(frame);
  getSessionState.mockReturnValue({ lastCapturedLine });
  return buildCurrentOutput({} as Database.Database, 'wt-1910', cliToolId, cliToolId);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------

describe('Issue #1910: capture content on the live copilot pane', () => {
  const cursor = pollerCursorFor(COPILOT_FRAME);

  it('the fixture reproduces the defect: the pre-fix slice is empty', () => {
    // The whole bug in one expression — this is what the builder used to do.
    expect(cursor).toBeGreaterThanOrEqual(TUI_PANE_HEIGHT);
    expect(COPILOT_FRAME.split('\n').slice(cursor).join('\n')).toBe('');
    // ...and the reason the #1670 guard never rescued it: 1000 rows is nowhere
    // near the 10000-row capture window that condition is written against.
    expect(COPILOT_FRAME.split('\n').length).toBeLessThan(EFFECTIVE_WINDOW);
  });

  it('publishes the whole frame as content once the cursor is known to be dead', async () => {
    const payload = await build('copilot', COPILOT_FRAME, cursor);

    expect(payload.content).not.toBe('');
    expect(payload.content).toBe(payload.fullOutput);
    // The turn an operator ran `capture` to read.
    expect(payload.content).toContain('Write a 400 word essay about the history of the semicolon');
    expect(payload.content).toContain('The History of the Semicolon');
  });

  it('leaves lineCount and lastCapturedLine reporting exactly what they did before', async () => {
    const payload = await build('copilot', COPILOT_FRAME, cursor);

    // Additive principle: `content` widened, the two numbers next to it did not
    // change meaning. `wait` and orchestrate-monitor read all three.
    expect(payload.lineCount).toBe(COPILOT_FRAME.split('\n').length);
    expect(payload.lastCapturedLine).toBe(cursor);
  });
});

describe('Issue #1910: every alternate-screen tool, at its own pane height', () => {
  it.each(ALT_SCREEN_TOOLS)('%s publishes the frame instead of an empty string', async (tool) => {
    const rows = PANE_HEIGHT[tool] ?? TUI_PANE_HEIGHT;
    const frame = buildFrame(rows, tool.toUpperCase());

    // Exactly the state a one-turn session is in: the stored cursor is the
    // pane height, and the next capture is the same pane height.
    const payload = await build(tool, frame, rows);

    expect(payload.content).toContain(`${tool.toUpperCase()} HEAD ROW`);
    expect(payload.content).toBe(frame);
  });
});

describe('Issue #1910 non-regression: the cursor still works for scrollback tools', () => {
  it.each(SCROLLBACK_TOOLS)('%s still receives only the rows past the cursor', async (tool) => {
    const rows = 300;
    const cursor = 200;
    const frame = buildFrame(rows, tool.toUpperCase());
    const expected = frame.split('\n').slice(cursor).join('\n');

    const payload = await build(tool, frame, cursor);

    // The capture is far below the window, so the count IS a cursor for these
    // tools — widening content to the whole frame here would re-publish rows the
    // poller already saved and defeat `wait`'s stall detection.
    expect(capturedLineCountIsCursor(tool, false)).toBe(true);
    expect(payload.content).toBe(expected);
    expect(payload.content).not.toContain(`${tool.toUpperCase()} HEAD ROW`);
    expect(payload.content).not.toContain(`${tool.toUpperCase()} MIDDLE ROW`);
    expect(payload.content).toContain(`${tool.toUpperCase()} TAIL ROW`);
  });

  it('still falls back to the whole capture when the window saturates (Issue #1670)', async () => {
    const frame = buildFrame(EFFECTIVE_WINDOW, 'CODEX');

    const payload = await build('codex', frame, 9000);

    expect(payload.content).toBe(frame);
    expect(payload.content).toContain('CODEX HEAD ROW');
  });
});

describe('capturedLineCountIsCursor', () => {
  it('is false for an alternate-screen tool no matter what the window did', () => {
    for (const tool of ALT_SCREEN_TOOLS) {
      expect(capturedLineCountIsCursor(tool, false)).toBe(false);
      expect(capturedLineCountIsCursor(tool, true)).toBe(false);
    }
  });

  it('is true for a scrollback tool only while the window is unsaturated', () => {
    for (const tool of SCROLLBACK_TOOLS) {
      expect(capturedLineCountIsCursor(tool, false)).toBe(true);
      expect(capturedLineCountIsCursor(tool, true)).toBe(false);
    }
  });
});
