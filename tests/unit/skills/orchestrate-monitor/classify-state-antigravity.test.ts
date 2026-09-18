import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13 } from '@tests/fixtures/model-info-captures';

/**
 * Issue #2606 — the monitor read every Antigravity (agy) worker as idle.
 *
 * In the #2595 pilot all 59 polls of an agy worker came out `IDLE started=0`;
 * `GENERATING` and `PROMPT` never appeared once. Two things were wrong, and
 * the frames below exercise both:
 *
 *  1. The markers were Claude's (`esc to interrupt`, `❯ 1.`, `? for shortcuts`).
 *     agy says `esc to cancel`, draws a braille spinner, puts its dialogs above
 *     an `↑/↓ Navigate` footer, and stops drawing `? for shortcuts` after a tool
 *     turn (#2478).
 *  2. The window was the wrong one for agy. agy renders inline in a 200x1000
 *     pane and is top-anchored, so until the transcript fills the pane the last
 *     100 rows — `realtimeSnippet` — are nothing but blank padding.
 *
 * Every frame is an existing live capture (no new recording): the agy
 * directories under `tests/fixtures/` and the one generating capture in the
 * repository, `ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13`
 * (`tests/fixtures/antigravity-live-2478/README.md` names it as such). The
 * `capture --json` payload is built around each frame the way the server
 * builds it (`src/lib/session/current-output-builder.ts`): `realtimeSnippet` is
 * `lines.slice(-100)` and `content` is `lines.slice(lastCapturedLine)`, both
 * over the untrimmed capture.
 *
 * The status fields are the idle-looking ones on purpose. The server reports
 * `waiting` for an open agy dialog, which would make PROMPT pass without the
 * text marker ever being read; neutral fields are what prove the marker.
 */

const SCRIPTS = path.join(process.cwd(), '.claude/skills/orchestrate-monitor/scripts');
const CLASSIFY = path.join(SCRIPTS, 'classify-state.sh');
const LIB = path.join(SCRIPTS, 'monitor-lib.sh');
const FIXTURES = path.join(process.cwd(), 'tests/fixtures');

/** The geometry every agy session is launched with (TUI_PANE_HEIGHT). */
const PANE_ROWS = 1000;

function liveFrame(rel: string): string {
  return readFileSync(path.join(FIXTURES, rel), 'utf8');
}

/** Pad a top-anchored capture down to the pane height, as tmux returns it. */
function padToPane(text: string): string {
  const rows = text.split('\n');
  while (rows.length < PANE_ROWS) rows.push('');
  return `${rows.join('\n')}\n`;
}

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-9;]*[a-zA-Z]/g, '');

/** The rows of a frame down to its last non-blank one. */
function contentRows(pane: string): string[] {
  const rows = pane.split('\n');
  let last = rows.length - 1;
  while (last >= 0 && stripAnsi(rows[last]).trim() === '') last--;
  return rows.slice(0, last + 1);
}

/**
 * A live frame with extra rows inserted above a row agy drew. Used only where a
 * test needs text the captures do not carry (a quoted footer, a retry line);
 * every row agy drew is kept verbatim.
 */
function insertRowsAbove(pane: string, at: number, extra: string[]): string {
  const rows = pane.split('\n');
  expect(at).toBeGreaterThan(0);
  rows.splice(at, 0, ...extra);
  return rows.join('\n');
}

/** Index of the last row matching `anchor` (ANSI stripped). */
function lastRow(pane: string, anchor: RegExp): number {
  const rows = pane.split('\n');
  for (let i = rows.length - 1; i >= 0; i--) {
    if (anchor.test(stripAnsi(rows[i]))) return i;
  }
  return -1;
}

/** Index of the input box's UPPER rule: the nearest rule above the last bare `>`. */
function inputBoxTop(pane: string): number {
  const rows = pane.split('\n');
  for (let i = lastRow(pane, /^>\s*$/) - 1; i >= 0; i--) {
    if (/^─{3,}$/.test(stripAnsi(rows[i]))) return i;
  }
  return -1;
}

/** Rows inserted above the input box, i.e. at the end of the transcript. */
function withRowsAboveBox(pane: string, extra: string[]): string {
  return insertRowsAbove(pane, inputBoxTop(pane), extra);
}

/**
 * Where the poller's cursor (`lastCapturedLine`) sits, which decides what
 * `content` holds:
 *  - `whole`: 0, e.g. right after a geometry-delegation reset or on a
 *    non-cursor capture — `content` is the whole pane;
 *  - `last-turn`: the last `─×60` turn separator, i.e. the poller saved the
 *    previous turn — `content` is the current turn and the live UI under it;
 *  - `scrolled`: the transcript has outgrown the pane (filler history above
 *    the verbatim frame, no padding below), and the cursor is at the end, so
 *    `content` is empty and only `realtimeSnippet` carries the frame.
 */
type Window = 'whole' | 'last-turn' | 'scrolled';
const WINDOWS: Window[] = ['whole', 'last-turn', 'scrolled'];

function lastTurnSeparator(rows: string[]): number {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (/^─{60}$/.test(stripAnsi(rows[i]).trim())) return i;
  }
  return 0;
}

function capturePayload(
  pane: string,
  window: Window,
  fields: Record<string, unknown> = {},
): Record<string, unknown> {
  let lines = pane.split('\n');
  let cursor = 0;
  if (window === 'last-turn') {
    cursor = lastTurnSeparator(lines);
  } else if (window === 'scrolled') {
    const history = Array.from({ length: PANE_ROWS }, (_, i) => `  scrolled history row ${i}`);
    lines = [...history, ...contentRows(pane), ''];
    cursor = lines.length;
  }
  return {
    isRunning: true,
    cliToolId: 'antigravity',
    sessionStatus: 'ready',
    sessionStatusReason: 'input_prompt',
    content: lines.slice(cursor).join('\n'),
    realtimeSnippet: lines.slice(-100).join('\n'),
    lineCount: lines.length,
    lastCapturedLine: cursor,
    isComplete: false,
    isGenerating: false,
    thinking: false,
    thinkingMessage: null,
    isPromptWaiting: false,
    promptData: null,
    ...fields,
  };
}

let tmpDir = '';
let seq = 0;

beforeAll(() => {
  tmpDir = mkdtempSync(path.join(os.tmpdir(), 'ml-agy-test-'));
});

afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function writePayload(payload: Record<string, unknown>): string {
  seq += 1;
  const file = path.join(tmpDir, `poll-${seq}.json`);
  // What `capture --json` writes: JSON.stringify(payload, null, 2).
  writeFileSync(file, JSON.stringify(payload, null, 2));
  return file;
}

function classify(payload: Record<string, unknown>): string {
  return execFileSync('bash', [CLASSIFY, '--json', writePayload(payload)], {
    encoding: 'utf8',
  }).trim();
}

function sh(snippet: string): string {
  return execFileSync('bash', ['-c', `set -u; . "${LIB}"; ${snippet}`], { encoding: 'utf8' });
}

/** yes/no for a predicate helper, so a swallowed exit code never reads as a pass. */
function predicate(fn: string, payload: Record<string, unknown>): boolean {
  const out = sh(`if ${fn} "${writePayload(payload)}"; then echo yes; else echo no; fi`).trim();
  expect(out).toMatch(/^(yes|no)$/);
  return out === 'yes';
}

const GENERATING = padToPane(ANTIGRAVITY_GENERATING_CAPTURE_V1_1_13);

const NUMBERED_DIALOGS = [
  'antigravity-live-2364/dialog-create-file.txt',
  'antigravity-live-2364/dialog-create-file-highlight-2.txt',
  'antigravity-live-2364/dialog-bash-oneline.txt',
  'antigravity-live-2364/dialog-bash-wrapped.txt',
  'antigravity-live-2364/dialog-bash-wrapped-highlight-4.txt',
  'antigravity-live-2364/dialog-bash-wrapped-six.txt',
];

const IDLE_FRAMES = [
  'antigravity-live-2364/boot-idle.txt',
  'antigravity-live-2364/idle-after-deny.txt',
  'antigravity-live-2478/after-tool-turn.txt',
  'antigravity-live-2478/after-plain-turns.txt',
  'agent-mode-2592/antigravity-default.txt',
  'agent-mode-2592/antigravity-accept-edits.txt',
  'agent-mode-2592/antigravity-plan.txt',
];

/** agy's arrow-key screens that carry no numbered options. */
const UNNUMBERED_SCREENS = [
  'antigravity-live-2364/trust-dialog.txt',
  'antigravity-live-2364/picker-switch-model.txt',
  'antigravity-live-2364/popup-slash-commands.txt',
];

describe('the window the Claude anchors read is blank on a short agy pane', () => {
  it.each([...NUMBERED_DIALOGS, ...IDLE_FRAMES])('%s: realtimeSnippet has no content', (rel) => {
    // Root cause 2. These frames are production geometry (200x1000, top
    // anchored), so the last 100 rows are padding. Nothing that reads only
    // realtimeSnippet can classify them, whatever its markers are.
    const rows = liveFrame(rel).split('\n');
    expect(rows.length).toBeGreaterThanOrEqual(PANE_ROWS);
    expect(rows.slice(-100).every((row) => stripAnsi(row).trim() === '')).toBe(true);
  });

  it('the padded generating capture has the same shape', () => {
    const rows = GENERATING.split('\n');
    expect(rows.slice(-100).every((row) => row.trim() === '')).toBe(true);
  });
});

describe.each(WINDOWS)('classify-state on agy frames (Issue #2606), window=%s', (window) => {
  it('GENERATING on the `esc to cancel` status row and the braille spinner', () => {
    expect(classify(capturePayload(GENERATING, window))).toBe('GENERATING');
  });

  it.each(NUMBERED_DIALOGS)('PROMPT on the numbered dialog %s', (rel) => {
    // Its status row also reads `esc to cancel`: the dialog is evaluated first,
    // so the frame is never GENERATING, and an approval is never skipped.
    expect(classify(capturePayload(liveFrame(rel), window))).toBe('PROMPT');
  });

  it.each(IDLE_FRAMES)('IDLE on %s', (rel) => {
    // Includes the #2478 frame (after-tool-turn.txt), whose status row holds
    // only the model label, and idle-after-deny.txt, whose transcript still
    // says "Generating the specified file".
    expect(classify(capturePayload(liveFrame(rel), window))).toBe('IDLE');
  });

  it.each(UNNUMBERED_SCREENS)('%s is not read as generating by the text markers', (rel) => {
    // popup-slash-commands.txt prints `esc to cancel` too. With neutral status
    // fields nothing names it a prompt either; the server's `waiting` does
    // (next test), exactly as it did before this Issue.
    expect(classify(capturePayload(liveFrame(rel), window))).toBe('IDLE');
  });
});

describe('classify-state keeps the server fields and the per-CLI split', () => {
  it.each(UNNUMBERED_SCREENS)('PROMPT on %s when the server reports waiting', (rel) => {
    const payload = capturePayload(liveFrame(rel), 'whole', {
      sessionStatus: 'waiting',
      sessionStatusReason: 'antigravity_selection_list',
    });
    expect(classify(payload)).toBe('PROMPT');
  });

  it('NOT_RUNNING still wins on an agy payload', () => {
    const payload = capturePayload(GENERATING, 'whole', { isRunning: false });
    expect(classify(payload)).toBe('NOT_RUNNING');
  });

  it('reads an agy frame with the Claude markers when cliToolId is not antigravity', () => {
    // The markers are chosen by cliToolId, and the Claude set is unchanged: it
    // does not know agy's words, so the same generating frame is IDLE there.
    const payload = capturePayload(GENERATING, 'scrolled', { cliToolId: 'claude' });
    expect(classify(payload)).toBe('IDLE');
  });

  it('does not read a Claude frame with the agy markers', () => {
    // live-generating-pre-token.json is GENERATING only through Claude's
    // `esc to interrupt`; relabelled as agy it has none of agy's markers.
    const fixture = path.join(
      process.cwd(),
      'tests/unit/skills/orchestrate-monitor/fixtures/live-generating-pre-token.json',
    );
    const payload = JSON.parse(readFileSync(fixture, 'utf8')) as Record<string, unknown>;
    expect(classify(payload)).toBe('GENERATING');
    expect(classify({ ...payload, cliToolId: 'antigravity' })).toBe('IDLE');
  });

  it('falls through to IDLE when neither field carries a row of the pane', () => {
    // The one case the payload cannot answer: a short pane (blank
    // realtimeSnippet) and a cursor past its last row (empty content). The
    // classifier reports the default rather than inventing a state; the task
    // state from hooks-task.sh stays the completion source for such a worker.
    const lines = GENERATING.split('\n');
    const payload = capturePayload(GENERATING, 'whole', {
      content: '',
      lastCapturedLine: lines.length,
    });
    expect(classify(payload)).toBe('IDLE');
  });
});

describe('agy markers in monitor-lib', () => {
  describe('ml_agy_has_gen_anchor', () => {
    it('fires on the generating capture', () => {
      expect(predicate('ml_agy_has_gen_anchor', capturePayload(GENERATING, 'whole'))).toBe(true);
    });

    it.each(['antigravity-live-2364/dialog-create-file.txt', 'antigravity-live-2364/popup-slash-commands.txt'])(
      'is vetoed by the dialog footer on %s, although `esc to cancel` is on screen',
      (rel) => {
        const payload = capturePayload(liveFrame(rel), 'whole');
        expect(liveFrame(rel)).toContain('esc to cancel');
        expect(predicate('ml_agy_has_dialog_footer', payload)).toBe(true);
        expect(predicate('ml_agy_has_gen_anchor', payload)).toBe(false);
      },
    );

    it.each(IDLE_FRAMES)('does not fire on %s', (rel) => {
      expect(predicate('ml_agy_has_gen_anchor', capturePayload(liveFrame(rel), 'whole'))).toBe(false);
    });
  });

  describe('ml_agy_has_prompt_marker', () => {
    it.each(NUMBERED_DIALOGS)('fires on %s', (rel) => {
      expect(predicate('ml_agy_has_prompt_marker', capturePayload(liveFrame(rel), 'whole'))).toBe(true);
    });

    it.each([
      ...UNNUMBERED_SCREENS,
      // Numbered rows, but a `1-6 Select & Continue` footer and no `↑/↓ Navigate`.
      'antigravity-live-2364/dialog-feedback-category.txt',
      'antigravity-live-2364/survey-after-deny.reconstructed.txt',
    ])('does not fire on %s', (rel) => {
      expect(predicate('ml_agy_has_prompt_marker', capturePayload(liveFrame(rel), 'whole'))).toBe(false);
    });

    it('does not fire on a footer and numbered list quoted in the transcript', () => {
      // A worker on this very Issue writes exactly this into its summary. The
      // input box is at the bottom, so the quoted footer is not agy's screen.
      const pane = withRowsAboveBox(liveFrame('antigravity-live-2478/after-tool-turn.txt'), [
        '  The dialog reads:',
        '  1. Yes',
        '  2. No',
        '  ↑/↓ Navigate · tab Amend',
        '',
      ]);
      const payload = capturePayload(pane, 'whole');
      expect(predicate('ml_agy_has_prompt_marker', payload)).toBe(false);
      expect(predicate('ml_agy_has_idle_box', payload)).toBe(true);
      expect(classify(payload)).toBe('IDLE');
    });
  });

  describe('ml_agy_has_idle_box', () => {
    it.each(IDLE_FRAMES)('is true on %s', (rel) => {
      expect(predicate('ml_agy_has_idle_box', capturePayload(liveFrame(rel), 'whole'))).toBe(true);
    });

    it('does not need `? for shortcuts` (agy 1.2.1 after a tool turn, #2478)', () => {
      const pane = liveFrame('antigravity-live-2478/after-tool-turn.txt');
      expect(pane).not.toContain('? for shortcuts');
      expect(predicate('ml_has_idle_footer', capturePayload(pane, 'whole'))).toBe(false);
      expect(predicate('ml_agy_has_idle_box', capturePayload(pane, 'whole'))).toBe(true);
    });

    it('is false while agy generates, although the box is drawn', () => {
      expect(GENERATING).toMatch(/^>$/m);
      expect(predicate('ml_agy_has_idle_box', capturePayload(GENERATING, 'whole'))).toBe(false);
    });

    it.each([...NUMBERED_DIALOGS, ...UNNUMBERED_SCREENS])('is false on %s', (rel) => {
      // The /model picker draws the box ABOVE itself; only a box at the bottom counts.
      expect(predicate('ml_agy_has_idle_box', capturePayload(liveFrame(rel), 'whole'))).toBe(false);
    });
  });

  describe('ml_agy_is_retrying', () => {
    const RETRY_ROW = '  429 Too Many Requests · Retrying in 30s · attempt 3/10';

    it('is true for a backoff line on a live turn', () => {
      const pane = withRowsAboveBox(GENERATING, [RETRY_ROW]);
      expect(predicate('ml_agy_is_retrying', capturePayload(pane, 'whole'))).toBe(true);
    });

    it('is vetoed by the idle box, so a stale line cannot pin a finished worker', () => {
      const pane = withRowsAboveBox(liveFrame('antigravity-live-2478/after-tool-turn.txt'), [RETRY_ROW]);
      const payload = capturePayload(pane, 'whole');
      expect(predicate('ml_agy_is_retrying', payload)).toBe(false);
      expect(classify(payload)).toBe('IDLE');
    });

    it('is vetoed by an open dialog, so the approval is not hidden behind GENERATING', () => {
      // Above the dialog's `Create file` header, inside the 15 live rows.
      const frame = liveFrame('antigravity-live-2364/dialog-create-file.txt');
      const pane = insertRowsAbove(frame, lastRow(frame, /^Create file$/), [RETRY_ROW]);
      const payload = capturePayload(pane, 'whole');
      expect(predicate('ml_agy_is_retrying', payload)).toBe(false);
      expect(classify(payload)).toBe('PROMPT');
    });
  });

  describe('ml_agy_frame', () => {
    function frameRows(payload: Record<string, unknown>): string[] {
      return sh(`ml_agy_frame "${writePayload(payload)}"`).replace(/\n$/, '').split('\n');
    }

    it('reads content when realtimeSnippet is only padding, and ends on the status row', () => {
      const rows = frameRows(capturePayload(liveFrame('antigravity-live-2364/boot-idle.txt'), 'whole'));
      expect(rows[rows.length - 1]).toMatch(/^\? for shortcuts +Gemini 3\.8 Flash · hig$/);
      expect(rows).toContain('>');
    });

    it('reads realtimeSnippet when content is empty (a pane the transcript has filled)', () => {
      const rows = frameRows(capturePayload(liveFrame('antigravity-live-2364/dialog-create-file.txt'), 'scrolled'));
      expect(rows).toContain('Allow creation of this file?');
      expect(rows[rows.length - 1]).toMatch(/^esc to cancel +Gemini 3\.8 Flash · hig$/);
    });

    it('keeps at most 64 rows, all from the bottom', () => {
      const rows = frameRows(capturePayload(liveFrame('antigravity-live-2478/after-plain-turns.txt'), 'whole'));
      expect(rows).toHaveLength(64);
      expect(rows[rows.length - 1]).toMatch(/^\? for shortcuts/);
    });

    it('turns JSON escapes back into rows, but not an escaped backslash before n', () => {
      const payload = {
        isRunning: true,
        cliToolId: 'antigravity',
        content: '',
        realtimeSnippet: 'path C:\\new "quoted"\n>\nlast',
      };
      expect(frameRows(payload)).toEqual(['path C:\\new "quoted"', '>', 'last']);
    });
  });
});
