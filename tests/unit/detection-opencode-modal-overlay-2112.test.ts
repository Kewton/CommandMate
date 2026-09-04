/**
 * Issue #2112: an open opencode dialog must never read as a finished turn.
 *
 * ## What was measured, and by whom
 *
 * Nothing new was captured for this Issue, and nothing needed to be. Its
 * evidence is already committed:
 *
 *  - `tests/fixtures/opencode-live-2046/w80/dialog-*.txt` — the four dialogs
 *    `ctrl+x l`, `ctrl+x a`, `ctrl+x g` and `ctrl+p` open on a live opencode
 *    1.18.22 at the 80 columns production runs it at;
 *  - `tests/fixtures/opencode-live-2047/w{80,120,200}/command-palette.txt` — the
 *    same palette over a BUSY transcript at three widths, which is the case a
 *    row-shaped rule cannot read;
 *  - `tests/unit/lib/detection/fixtures/opencode-live-1896/` — #1896's pickers
 *    and its prose trap (`select-model-in-response.txt`).
 *
 * The one file this Issue adds is `tests/fixtures/opencode-modal-overlay-2112/
 * words-in-response.txt`, and it is DERIVED from `sidebar-off.txt` rather than
 * captured — no live session was ever asked to say `Sessions`, `Commands`,
 * `Timeline` and `Select agent` in its reply. That directory's README lists the
 * four substitutions.
 *
 * Re-derived from the committed bytes on 2026-08-27, the four dialogs read
 * `ready` / `opencode_response_complete` (three of them) and `running` /
 * `unknown_frame` (the palette) before this change — i.e. exactly the table in
 * the Issue body. The three `ready` ones are the bug: `ready` is POSITIVE
 * evidence, so `isUnclassifiedActive` stayed false, #1708's 60-second hatch
 * never opened, and `commandmate wait` exited 0 on a pane blocked on a human.
 *
 * ## Why the rule is layout and not a longer word list
 *
 * `OPENCODE_SELECTION_LIST_PATTERN` allowlists three headings, and the obvious
 * repair is to add the five it is missing. `WORDS_IN_RESPONSE` below is a frame
 * that would defeat exactly that repair: four transcript rows, each shaped
 * `<heading>  …  esc`, over a genuinely finished turn. `A_WIDENED_ALLOWLIST`
 * fires on it — asserted, so the trap cannot quietly stop being one — and the
 * published rule does not, because what it reads is that opencode paints its
 * dialogs as a background rectangle whose rows share both edges and whose title
 * bar carries the `esc` hatch flush to the right one.
 *
 * @vitest-environment node
 */

import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  detectOpenCodeModalOverlay,
  extractOpenCodeModalOverlayFrame,
  OPENCODE_MODAL_OVERLAY_ID,
  OPENCODE_MODAL_OVERLAY_RECOVERY_KEY,
  OPENCODE_OVERLAY_HEADER_ROW_LIMIT,
  OPENCODE_OVERLAY_MIN_LEFT,
  OPENCODE_OVERLAY_MIN_ROWS,
  OPENCODE_OVERLAY_MIN_WIDTH,
} from '@/lib/detection/opencode-modal-overlay';
import { detectOpenCodePaneObstruction } from '@/lib/detection/opencode-pane-obstruction';
import {
  detectSessionStatus,
  SELECTION_LIST_REASONS,
  STATUS_REASON,
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_SELECTION_LIST_PATTERN,
} from '@/lib/detection/cli-patterns';
import { deriveWaitingKind } from '@/lib/session/waiting-kind';
import { isUnclassifiedFrame } from '@/lib/session/status-evidence';
import { isOpenCodeComplete } from '@/lib/response-extractor';
import { CLAUDE_MODEL_OVERLAY_V2_1_218 } from '../fixtures/claude-model-overlay';
import { buildClaudeHelpOverlayFrame } from '../fixtures/claude-help-overlay';
import {
  CODEX_APPROVAL_PANE,
  CODEX_HOOKS_DETAIL_PANE,
  CODEX_HOOKS_LIST_PANE,
  CODEX_HOOKS_REVIEW_PANE,
} from '../fixtures/codex-hooks-review-0148';
import {
  buildCopilotFolderTrustFrame,
  buildCopilotReadyFrame,
} from '../fixtures/copilot-folder-trust-1080';
import type { CLIToolType } from '@/lib/cli-tools/types';

const DIR_2046 = path.resolve(__dirname, '../fixtures/opencode-live-2046/w80');
const DIR_2047 = path.resolve(__dirname, '../fixtures/opencode-live-2047');
const DIR_2112 = path.resolve(__dirname, '../fixtures/opencode-modal-overlay-2112');
const DIR_1896 = path.resolve(__dirname, 'lib/detection/fixtures/opencode-live-1896');

/** The four dialogs #2046 opened with a keystroke on a live TUI. */
const DIALOGS = [
  'dialog-session-list',
  'dialog-agent-list',
  'dialog-timeline',
  'dialog-command-palette',
] as const;

function frame2046(name: string): string {
  return fs.readFileSync(path.join(DIR_2046, `${name}.txt`), 'utf-8');
}

const WORDS_IN_RESPONSE = fs.readFileSync(path.join(DIR_2112, 'words-in-response.txt'), 'utf-8');

/**
 * The repair this Issue did NOT make: `OPENCODE_SELECTION_LIST_PATTERN` with the
 * five missing headings added.
 *
 * Spelled out here rather than described, so the negative control is tested
 * against the actual alternative and not against a summary of it.
 */
const A_WIDENED_ALLOWLIST =
  /^[^\S\n]*(?:Select[^\S\n]+(?:model|provider|agent)|Sessions|Timeline|Commands)[^\S\n]{2,}esc[^\S\n]*$/m;

/** The status detector as every production caller invokes it for opencode. */
function statusOf(raw: string, tool: CLIToolType = 'opencode'): StatusDetectionResult {
  resetDetectPromptCache();
  return detectSessionStatus(raw, tool);
}

/**
 * The three published facts a blocked pane turns on, derived the way the server
 * derives them.
 *
 * `isSelectionListActive` is `current-output-builder`'s expression (`waiting` +
 * a {@link SELECTION_LIST_REASONS} reason); `waitCompletes` is `wait`'s Path B,
 * which is `sessionStatus === 'ready' && isUnclassifiedActive !== true`
 * (`src/cli/commands/wait.ts`).
 */
function publishedOf(raw: string) {
  const status = statusOf(raw);
  const isUnclassifiedActive = isUnclassifiedFrame(status.status, status.reason);
  return {
    status: status.status,
    reason: status.reason,
    evidence: status.evidence,
    hasActivePrompt: status.hasActivePrompt,
    isUnclassifiedActive,
    isSelectionListActive:
      status.status === 'waiting' && SELECTION_LIST_REASONS.has(status.reason),
    waitCompletes: status.status === 'ready' && isUnclassifiedActive !== true,
    waitingKind: deriveWaitingKind({
      waiting: status.status === 'waiting',
      hasActivePrompt: status.hasActivePrompt,
      scraperStatus: status.status,
      scraperReason: status.reason,
    }),
  };
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('Issue #2112 acceptance: the four dialogs are never a completion', () => {
  it.each(DIALOGS)('%s reads as a modal overlay, not as `ready`', name => {
    const published = publishedOf(frame2046(name));

    // The acceptance criterion, in the Issue's own words.
    expect(published.status).not.toBe('ready');
    expect(published).toMatchObject({
      status: 'waiting',
      reason: STATUS_REASON.OPENCODE_MODAL_OVERLAY,
      evidence: 'positive',
      hasActivePrompt: false,
    });
  });

  it.each(DIALOGS)('%s shows NavigationButtons and stops `wait`', name => {
    const published = publishedOf(frame2046(name));

    // `isSelectionListActive` is what renders NavigationButtons and what makes
    // `wait` exit 10 (or keep waiting under `--on-prompt human`), and `menu` is
    // the #1786 taxonomy's word for "only the terminal can drive this" — which
    // is right: opencode's overlays take ↑/↓ and Enter, never a typed number.
    expect(published.isSelectionListActive).toBe(true);
    expect(published.waitingKind).toBe('menu');
    // Path B of `wait`'s completion check, closed.
    expect(published.waitCompletes).toBe(false);
  });

  it.each(DIALOGS)('%s carries the marker that used to be read as the verdict', name => {
    // Non-vacuity for the whole Issue. The overlay hides nothing: the finished
    // `▣ Build · Claude Sonnet 4.6 · 2.8s` row of the PREVIOUS turn is still on
    // the pane, and `isOpenCodeComplete` still finds it. Branch D matched that
    // row and answered `ready` for three of these four frames. The gate is what
    // stops a real marker from the past being read as this moment's verdict —
    // not the marker going away.
    expect(isOpenCodeComplete(stripAnsi(frame2046(name)))).toBe(true);
  });

  it.each(DIALOGS)('%s is not a prompt the app could answer for you', name => {
    resetDetectPromptCache();
    const prompt = detectPrompt(
      stripBoxDrawing(stripAnsi(frame2046(name))),
      buildDetectPromptOptions('opencode'),
    );
    expect(prompt.isPrompt).toBe(false);
  });

  it('closes with `esc`, which is the affordance the rule anchors on', () => {
    // The published recovery key is the overlay's own hatch, not a guess: it is
    // literally the token this module matches. Pinned so no surface grows a bare
    // key literal that could drift from what the detector reads.
    expect(OPENCODE_MODAL_OVERLAY_RECOVERY_KEY).toBe('esc');
    for (const name of DIALOGS) {
      const overlay = detectOpenCodeModalOverlay(frame2046(name));
      expect(overlay?.headerText.endsWith(OPENCODE_MODAL_OVERLAY_RECOVERY_KEY)).toBe(true);
    }
  });
});

describe('Issue #2112: the controls this change must not move', () => {
  it('leaves the home screen `ready` / `input_prompt`', () => {
    expect(publishedOf(frame2046('home-idle'))).toMatchObject({
      status: 'ready',
      reason: STATUS_REASON.INPUT_PROMPT,
    });
  });

  it.each(['sidebar-off', 'agent-build', 'agent-plan'] as const)(
    '%s is still a finished turn',
    name => {
      expect(publishedOf(frame2046(name))).toMatchObject({
        status: 'ready',
        reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
      });
    },
  );

  it('leaves the sidebar frame on the unclassified floor #2095 published a cause for', () => {
    expect(publishedOf(frame2046('sidebar-on'))).toMatchObject({
      status: 'running',
      reason: STATUS_REASON.UNKNOWN_FRAME,
      isUnclassifiedActive: true,
    });
  });

  it.each([
    ['opencode-live-1896/model-picker', path.join(DIR_1896, 'model-picker.txt')],
  ] as const)('%s keeps answering through the heading allowlist', (_id, file) => {
    // Branch C still runs first, so a frame the allowlist CAN read keeps its own
    // reason. The two readings agree about the verdict and disagree about which
    // rule got there, which is the distinction `opencode_modal_overlay` exists
    // to publish.
    const raw = fs.readFileSync(file, 'utf-8');
    expect(statusOf(raw)).toMatchObject({
      status: 'waiting',
      reason: STATUS_REASON.OPENCODE_SELECTION_LIST,
    });
    expect(detectOpenCodeModalOverlay(raw)).not.toBeNull();
  });

  it.each([
    ['turn-running', 'opencode-live-2047/w80/turn-running.txt'],
    ['esc-again-window', 'opencode-live-2047/w80/esc-again-window.txt'],
  ] as const)('%s says `esc` in a painted footer and is still `running`', (_id, rel) => {
    // The composer IS a painted rectangle and its footer DOES say `esc`. What
    // separates it from a dialog is that the word is followed by `interrupt`
    // rather than by the rectangle's right edge.
    const raw = fs.readFileSync(path.join(DIR_2047, '..', rel), 'utf-8');
    expect(stripAnsi(raw)).toContain('esc');
    expect(detectOpenCodeModalOverlay(raw)).toBeNull();
    expect(statusOf(raw).status).toBe('running');
  });
});

describe('Issue #2112: the negative control — the headings written in a reply', () => {
  it('would be caught by the repair this Issue did not make', () => {
    // Non-vacuity for the control itself. If a future edit stopped this frame
    // looking like a picker to a word list, the assertions below would pass for
    // the wrong reason.
    expect(A_WIDENED_ALLOWLIST.test(stripAnsi(WORDS_IN_RESPONSE))).toBe(true);
    for (const heading of ['Sessions', 'Commands', 'Timeline', 'Select agent']) {
      expect(stripAnsi(WORDS_IN_RESPONSE)).toContain(heading);
    }
  });

  it('is not an overlay, and is still the finished turn it is', () => {
    expect(detectOpenCodeModalOverlay(WORDS_IN_RESPONSE)).toBeNull();
    expect(publishedOf(WORDS_IN_RESPONSE)).toMatchObject({
      status: 'ready',
      reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
      isSelectionListActive: false,
      waitCompletes: true,
    });
  });

  it('keeps #1896’s own prose trap answering the way #1896 left it', () => {
    const raw = fs.readFileSync(path.join(DIR_1896, 'select-model-in-response.txt'), 'utf-8');
    expect(detectOpenCodeModalOverlay(raw)).toBeNull();
    expect(statusOf(raw)).toMatchObject({
      status: 'ready',
      reason: STATUS_REASON.OPENCODE_RESPONSE_COMPLETE,
    });
    expect(OPENCODE_SELECTION_LIST_PATTERN.test(stripAnsi(raw))).toBe(false);
  });
});

describe('Issue #2112: no other tool moves', () => {
  // The cross-check the Issue asks for, re-measured from these fixtures on
  // 2026-08-27 and pinned. `detectOpenCodeModalOverlay` is reachable only from
  // opencode's own detector, so this is a statement about the wiring rather than
  // about the rule — which is exactly what could be got wrong by accident.
  it.each([
    ['claude /model overlay', CLAUDE_MODEL_OVERLAY_V2_1_218, 'claude', 'waiting', STATUS_REASON.CLAUDE_SELECTION_LIST],
    ['claude /help overlay', buildClaudeHelpOverlayFrame(), 'claude', 'running', STATUS_REASON.DEFAULT],
    ['codex approval', CODEX_APPROVAL_PANE, 'codex', 'waiting', STATUS_REASON.PROMPT_DETECTED],
    ['codex hooks review', CODEX_HOOKS_REVIEW_PANE, 'codex', 'waiting', STATUS_REASON.CODEX_SELECTION_LIST],
    ['codex hooks list', CODEX_HOOKS_LIST_PANE, 'codex', 'waiting', STATUS_REASON.CODEX_HOOKS_REVIEW],
    ['codex hooks detail', CODEX_HOOKS_DETAIL_PANE, 'codex', 'waiting', STATUS_REASON.CODEX_HOOKS_REVIEW],
    ['copilot folder trust', buildCopilotFolderTrustFrame(), 'copilot', 'waiting', STATUS_REASON.PROMPT_DETECTED],
    ['copilot ready', buildCopilotReadyFrame(), 'copilot', 'ready', STATUS_REASON.INPUT_PROMPT],
  ] as const)('%s stays %s / %s', (_label, raw, tool, status, reason) => {
    expect(statusOf(raw, tool)).toMatchObject({ status, reason });
  });
});

describe('Issue #2112: what the rule actually reads', () => {
  it('pins the reason literal against the module that defines the signature', () => {
    // `status-reason.ts` restates the string so it can keep its no-imports
    // property. This is the pin that stops the restatement drifting.
    expect(STATUS_REASON.OPENCODE_MODAL_OVERLAY).toBe(OPENCODE_MODAL_OVERLAY_ID);
    expect(SELECTION_LIST_REASONS.has(OPENCODE_MODAL_OVERLAY_ID)).toBe(true);
  });

  it.each([
    ['dialog-session-list', 1, 79, 10],
    ['dialog-agent-list', 10, 70, 9],
    ['dialog-timeline', 1, 79, 8],
    ['dialog-command-palette', 10, 70, 72],
  ] as const)('%s is a rectangle at columns %i–%i', (name, left, right, rows) => {
    // The geometry, as read off the committed bytes. The two 80-column widths
    // are opencode's own: the palette and the agent list are centred 60-column
    // boxes, the session list and the timeline are nearly pane-wide.
    expect(detectOpenCodeModalOverlay(frame2046(name))).toEqual({
      id: OPENCODE_MODAL_OVERLAY_ID,
      headerText: expect.stringContaining('esc'),
      left,
      right,
      rows,
      // Every measured overlay puts the hatch on the second row it paints; the
      // first is the box's top padding.
      headerRow: 1,
    });
  });

  it.each([80, 120, 200] as const)(
    'reads the palette at %i columns, where the transcript shows on both sides',
    width => {
      // The case a row-shaped rule cannot do. At 120 and 200 columns the rows
      // carrying the overlay are not equal in length and nothing outside the
      // rectangle is constant — only its two edges are.
      const raw = fs.readFileSync(path.join(DIR_2047, `w${width}`, 'command-palette.txt'), 'utf-8');
      const overlay = detectOpenCodeModalOverlay(raw);
      expect(overlay, `w${width}`).not.toBeNull();
      expect(overlay!.right - overlay!.left).toBe(60);
      expect(statusOf(raw)).toMatchObject({
        status: 'waiting',
        reason: STATUS_REASON.OPENCODE_MODAL_OVERLAY,
      });
    },
  );

  it('answers null once the ANSI is gone, and says so rather than guessing', () => {
    // The documented fail-open. Auto-Yes hands the detectors a frame that has
    // already been through `captureAndCleanOutput`, and on that path the
    // rectangle does not exist. `null` there means "could not read", never "no
    // overlay" — the same rule `opencode-pane-obstruction.ts` states for itself.
    for (const name of DIALOGS) {
      expect(detectOpenCodeModalOverlay(frame2046(name))).not.toBeNull();
      expect(detectOpenCodeModalOverlay(stripAnsi(frame2046(name)))).toBeNull();
    }
  });

  it('cannot be #2095’s rule wearing a different hat', () => {
    // The reuse question this Issue was told to answer, answered in an
    // assertion. `detectOpenCodePaneObstruction` looks for a SECOND COLUMN
    // sharing rows with the input box; a dialog leaves the box at its full
    // width and floats above it, so that rule reads nothing on all four frames
    // — while it does fire on the sidebar, which is its own case.
    for (const name of DIALOGS) {
      expect(detectOpenCodePaneObstruction(frame2046(name)), name).toBeNull();
    }
    expect(detectOpenCodePaneObstruction(frame2046('sidebar-on'))).not.toBeNull();
  });
});

/**
 * Synthetic frames, used only to prove that each guard decides something.
 *
 * Not evidence about opencode — the live captures above are. These exist so a
 * constant that has never been the thing that decided a verdict on a real frame
 * can still be shown to be load-bearing, one condition at a time.
 */
describe('Issue #2112: every guard is load-bearing', () => {
  const OVERLAY_BG = '\x1b[48;2;20;20;20m';
  const RESET = '\x1b[0m';

  /** One painted row: `left` unpainted columns, then `width` painted ones. */
  function paintedRow(left: number, width: number, content: string, gutter = ''): string {
    const body = `  ${content}`.padEnd(width, ' ').slice(0, width);
    const lead = gutter === '' ? ' '.repeat(left) : `${' '.repeat(left - 1)}${gutter}`;
    return `${lead}${OVERLAY_BG}${body}${RESET}`;
  }

  /**
   * A minimal dialog: a padding row, a title bar carrying the hatch, then items.
   *
   * Every option names one of the published guards, so a test below can violate
   * exactly one condition and leave the rest of the frame alone.
   */
  function dialog(options: {
    left?: number;
    width?: number;
    rows?: number;
    header?: string;
    headerAt?: number;
    hatch?: string;
    gutter?: string;
  } = {}): string {
    const left = options.left ?? 10;
    const width = options.width ?? 60;
    const rows = options.rows ?? 6;
    const header = options.header ?? 'Sessions';
    const headerAt = options.headerAt ?? 1;
    const hatch = options.hatch ?? 'esc';
    const gap = Math.max(2, width - 6 - header.length - hatch.length);
    const titleBar = `${header}${' '.repeat(gap)}${hatch}`;

    const lines: string[] = ['', ''];
    for (let i = 0; i < rows; i++) {
      const content = i === headerAt ? titleBar : i === 0 ? '' : `item ${i}`;
      lines.push(paintedRow(left, width, content, options.gutter));
    }
    lines.push('', '');
    return lines.join('\n');
  }

  it('reads the synthetic dialog at all, so the negatives below mean something', () => {
    const overlay = detectOpenCodeModalOverlay(dialog());
    expect(overlay).not.toBeNull();
    expect(overlay!.left).toBe(10);
    expect(overlay!.rows).toBe(6);
    expect(overlay!.headerRow).toBe(1);
  });

  it(`needs ${OPENCODE_OVERLAY_MIN_ROWS} rows`, () => {
    expect(detectOpenCodeModalOverlay(dialog({ rows: OPENCODE_OVERLAY_MIN_ROWS }))).not.toBeNull();
    expect(detectOpenCodeModalOverlay(dialog({ rows: OPENCODE_OVERLAY_MIN_ROWS - 1 }))).toBeNull();
  });

  it(`needs ${OPENCODE_OVERLAY_MIN_WIDTH} columns`, () => {
    expect(
      detectOpenCodeModalOverlay(dialog({ width: OPENCODE_OVERLAY_MIN_WIDTH, header: 'S' })),
    ).not.toBeNull();
    expect(
      detectOpenCodeModalOverlay(dialog({ width: OPENCODE_OVERLAY_MIN_WIDTH - 1, header: 'S' })),
    ).toBeNull();
  });

  it(`needs the rectangle to start at column ${OPENCODE_OVERLAY_MIN_LEFT} or beyond`, () => {
    // Column 0 is a theme painting the whole pane, not an overlay drawn over it.
    expect(detectOpenCodeModalOverlay(dialog({ left: OPENCODE_OVERLAY_MIN_LEFT }))).not.toBeNull();
    expect(detectOpenCodeModalOverlay(dialog({ left: 0 }))).toBeNull();
  });

  it('needs the hatch in the title bar, not somewhere down the list', () => {
    expect(
      detectOpenCodeModalOverlay(dialog({ rows: 12, headerAt: OPENCODE_OVERLAY_HEADER_ROW_LIMIT - 1 })),
    ).not.toBeNull();
    expect(
      detectOpenCodeModalOverlay(dialog({ rows: 12, headerAt: OPENCODE_OVERLAY_HEADER_ROW_LIMIT })),
    ).toBeNull();
  });

  it('needs the hatch flush to the right edge, which `esc interrupt` is not', () => {
    // opencode's composer is a painted rectangle whose footer says `esc` while
    // the agent is generating — `esc interrupt`, `esc again to interrupt`. The
    // live frames are asserted above; this is the same difference with
    // everything else held constant.
    expect(detectOpenCodeModalOverlay(dialog({ hatch: 'esc' }))).not.toBeNull();
    expect(detectOpenCodeModalOverlay(dialog({ hatch: 'esc interrupt' }))).toBeNull();
    expect(detectOpenCodeModalOverlay(dialog({ hatch: 'esc again to interrupt' }))).toBeNull();
  });

  it('needs no box gutter beside it, which is what the composer always has', () => {
    // The layout trap in `words-in-response.txt`, in one line: the same
    // rectangle, with opencode's `┃` in the column to its left.
    expect(detectOpenCodeModalOverlay(dialog({ gutter: '' }))).not.toBeNull();
    expect(detectOpenCodeModalOverlay(dialog({ gutter: '┃' }))).toBeNull();
  });
});

describe('Issue #2309: extractOpenCodeModalOverlayFrame crops to the rectangle', () => {
  it('keeps `detectOpenCodeModalOverlay`’s own public shape unchanged', () => {
    // The row-range fields this Issue adds internally must never leak onto the
    // detector's own return value — every existing caller (`tools/opencode/
    // detect.ts`, `tools/opencode/prompt.ts`) destructures a fixed field list,
    // and the `toEqual` above pins the exact shape.
    const overlay = detectOpenCodeModalOverlay(frame2046('dialog-session-list'));
    expect(overlay && Object.keys(overlay).sort()).toEqual(
      ['headerRow', 'headerText', 'id', 'left', 'right', 'rows'].sort(),
    );
  });

  it('crops a real dialog to exactly its painted rows, no blank padding left over', () => {
    // `dialog-timeline` is the shortest of the four #2046 captures (8 rows).
    // Every one of them carries the overlay's own background — some are text
    // rows, some are the panel's blank-but-painted spacer rows — and the crop
    // must keep exactly that span, no more.
    const cropped = extractOpenCodeModalOverlayFrame(frame2046('dialog-timeline'));
    expect(cropped).not.toBeNull();
    expect(cropped!.split('\n')).toHaveLength(8);
    expect(stripAnsi(cropped!)).toContain('Timeline');
    expect(stripAnsi(cropped!)).toContain('esc');
    // The pane rows outside the panel — the ones an un-cropped frame would
    // still carry — are not painted and so cannot be part of this span.
    expect(cropped).not.toBe(frame2046('dialog-timeline'));
  });

  it('reads the real four #2046 dialogs at the geometry their own test pins', () => {
    for (const [name, , , rows] of [
      ['dialog-session-list', 1, 79, 10],
      ['dialog-agent-list', 10, 70, 9],
      ['dialog-timeline', 1, 79, 8],
      ['dialog-command-palette', 10, 70, 72],
    ] as const) {
      const cropped = extractOpenCodeModalOverlayFrame(frame2046(name));
      expect(cropped, name).not.toBeNull();
      expect(cropped!.split('\n'), name).toHaveLength(rows);
    }
  });

  it('is null wherever detectOpenCodeModalOverlay is null', () => {
    for (const name of DIALOGS) {
      expect(extractOpenCodeModalOverlayFrame(stripAnsi(frame2046(name))), name).toBeNull();
    }
    expect(extractOpenCodeModalOverlayFrame('no overlay here at all')).toBeNull();
  });

  it('crops a busy transcript to the overlay rather than the conversation around it', () => {
    // The case #2309 exists for: a palette painted mid-transcript, prose on
    // both sides of it on the SAME rows. `w200/command-palette.txt` is the
    // 2047 fixture measured above at 60 columns wide.
    const raw = fs.readFileSync(path.join(DIR_2047, 'w200', 'command-palette.txt'), 'utf-8');
    const cropped = extractOpenCodeModalOverlayFrame(raw);
    expect(cropped).not.toBeNull();
    const plain = stripAnsi(cropped!);
    expect(plain).toContain('Commands');
    expect(plain).toContain('Switch model');
    // Full-width rows, not a column crop: the transcript sharing a row WITH
    // the overlay rides along on purpose (Issue #2095's sidebar precedent) —
    // only rows the rectangle never reaches are dropped.
    expect(plain).not.toContain('uname -a');
  });
});
