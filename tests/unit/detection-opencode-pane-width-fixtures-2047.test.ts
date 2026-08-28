/**
 * Issue #2047: what the opencode detectors depend on the pane width for.
 *
 * The Issue proposed raising opencode's pane from the 80 columns
 * `launchSession()` has always pinned it to, and made the raise conditional:
 * re-verify #1883 / #1893 / #1894 / #1896 and the #1911 turn-boundary path at
 * the wider geometry, raise the default only if every one of them answers what
 * it answers today, and if any of them does not, *record what was width-
 * dependent instead*.
 *
 * It was not, and this file is the record.
 *
 * ## The measurement
 *
 * opencode 1.18.22 paints a right-hand sidebar at **121 columns and wider**, and
 * hides it at **120 and narrower**. Walked one column at a time on a live TUI and
 * reproduced in both directions (119/120 → hidden, 121 → shown). The sidebar has
 * no region of its own in a `capture-pane`: it shares ROWS with the transcript,
 * so at ≥121 columns every line of the frame is
 * `<transcript text>   …   <sidebar text>`.
 *
 * Three readers in this repo break on that, measured on frames captured from the
 * SAME live session at 80, 120 and 200 columns (`tests/fixtures/opencode-live-2047`):
 *
 * 1. `sliceOpenCodeTurn` + `cleanOpenCodeResponse` save the sidebar as the
 *    assistant's reply. Structural — nothing about the conversation triggers it.
 * 2. `detectSessionStatus` flips an aborted turn from `ready` to `running`,
 *    because the sidebar's rows push the previous turn's duration-carrying `▣`
 *    marker out of branch D's content window.
 * 3. `OPENCODE_IDLE_COMPOSER_PATTERN` false-matches, because the sidebar prints
 *    the session TITLE on a row that already carries a transcript gutter — and
 *    `^\s*┃\s*Ask anything\.\.\.` cannot tell two panes sharing a row apart.
 *
 * At 120 columns every frame produced a byte-identical verdict to 80. **So the
 * default stays 80** (`OPENCODE_PANE_WIDTH`), 120 is recorded as the measured
 * safe ceiling, and `CM_OPENCODE_PANE_WIDTH` exists for an operator who wants to
 * spend it — see `tests/unit/cli-tools/opencode-pane-width-2047.test.ts` for the
 * setting itself and `docs/design/opencode-server-live-verification.md` §21 for
 * the full run.
 *
 * ## How to read the assertions
 *
 * The parity block is the load-bearing one: it compares w120 to w80 field by
 * field over every frame, with no expected values written down, so it fails if
 * ANY reader picks up a width dependency — including one nobody has thought of.
 * The divergence block pins the four w200 differences as facts, so a future
 * change that "fixes" the sidebar has to come here and say so.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { detectPrompt, resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import {
  detectSessionStatus,
  STATUS_REASON,
  type StatusDetectionResult,
} from '@/lib/detection/status-detector';
import {
  buildDetectPromptOptions,
  stripAnsi,
  stripBoxDrawing,
  OPENCODE_IDLE_COMPOSER_PATTERN,
  OPENCODE_PERMISSION_PATTERN,
  OPENCODE_PROCESSING_INDICATOR,
} from '@/lib/detection/cli-patterns';
import { isOpenCodeComplete, sliceOpenCodeTurn } from '@/lib/response-extractor';
import { cleanOpenCodeResponse } from '@/lib/response-cleaner';
import { resolvePromptWaiting } from '@/lib/session/prompt-waiting-composition';
import {
  OPENCODE_PANE_WIDTH,
  OPENCODE_SIDEBAR_MIN_WIDTH,
} from '@/config/tmux-pane-config';

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/opencode-live-2047');

/** Pane widths the same session was captured at. */
const WIDTHS = [80, 120, 200] as const;
type Width = (typeof WIDTHS)[number];

const FRAME_NAMES = [
  'boot-idle',
  'command-palette',
  'composer-residual',
  'double-esc-interrupted',
  'esc-again-window',
  'numbered-answer',
  'permission-bash',
  'permission-edit',
  'phrase-in-response',
  'sidebar-title-phrase',
  'turn-aborted-after-complete',
  'turn-complete',
  'turn-running',
] as const;
type FrameName = (typeof FRAME_NAMES)[number];

/**
 * Frames whose SAVED REPLY is comparable across widths.
 *
 * `command-palette` is out: an open overlay is painted over the transcript and
 * `sliceOpenCodeTurn` slices rows, so its extraction is part response and part
 * palette at every width, including 80. Pinned as its own fact below.
 */
const REPLY_PARITY_FRAMES = FRAME_NAMES.filter(
  (name): name is Exclude<FrameName, 'command-palette'> => name !== 'command-palette'
);

function frame(width: Width, name: FrameName): string {
  return fs.readFileSync(path.join(FIXTURE_DIR, `w${width}`, `${name}.txt`), 'utf-8');
}

/**
 * Every published verdict a single frame produces, in one comparable object.
 *
 * Deliberately not a hand-picked subset: the question "does the pane width
 * change anything" can only be answered by comparing everything the frame is
 * read for. Both status call paths are here because #1883 showed they are
 * separate — `response-checker` reaches `detectPrompt` without ever going
 * through the status detector — and the extraction pair is here because #2047's
 * worst finding lives there and in neither detector.
 */
function verdictOf(raw: string) {
  resetDetectPromptCache();
  const status: StatusDetectionResult = detectSessionStatus(raw, 'opencode');
  resetDetectPromptCache();
  const prompt = detectPrompt(
    stripBoxDrawing(stripAnsi(raw)),
    buildDetectPromptOptions('opencode')
  );
  const clean = stripAnsi(raw);

  return {
    status: status.status,
    reason: status.reason,
    hasActivePrompt: status.hasActivePrompt,
    evidence: status.evidence,
    // The composed verdict `wait` / the sidebar / the send guard actually read.
    // `ignoreStructured` because these frames come from a tmux capture with no
    // agent-event state behind them: the scraper half is the half a pane width
    // can move.
    promptWaiting: resolvePromptWaiting({
      worktreeId: 'wt-2047',
      cliToolId: 'opencode',
      scraper: status,
      ignoreStructured: true,
    }).waiting,
    isPrompt: prompt.isPrompt,
    promptType: prompt.promptData?.type ?? null,
    idleComposerPattern: OPENCODE_IDLE_COMPOSER_PATTERN.test(clean),
    permissionPattern: OPENCODE_PERMISSION_PATTERN.test(clean),
    processingPattern: OPENCODE_PROCESSING_INDICATOR.test(clean),
    turnComplete: isOpenCodeComplete(clean),
  };
}

/**
 * The saved reply, with ALL whitespace removed.
 *
 * Not comparable by equality across widths and deliberately kept out of
 * {@link verdictOf}: opencode hard-wraps its own response body to the pane, so a
 * 200-row window holds MORE of a long answer at 120 columns than at 80 — the
 * same reply, further along. It also wraps mid-token (`xnu-12377.` /
 * `161.14~5`), so collapsing runs to single spaces would still differ. Stripping
 * whitespace entirely leaves the one thing that must not change with the width:
 * which glyphs reach the saved reply, in order. See the prefix assertion below.
 */
function replyGlyphsOf(raw: string): string {
  return cleanOpenCodeResponse(stripAnsi(sliceOpenCodeTurn(raw))).replace(/\s+/g, '');
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('Issue #2047: the fixtures are raw captures of one session at three widths', () => {
  it('keeps the ANSI, the box drawing and the full 200-row height', () => {
    for (const width of WIDTHS) {
      for (const name of FRAME_NAMES) {
        const raw = frame(width, name);
        expect(raw, `w${width}/${name} lost its escape sequences`).toContain('\x1b[');
        expect(raw, `w${width}/${name} lost its box drawing`).toContain('┃');
        expect(
          raw.split('\n').length,
          `w${width}/${name} is not a full-height frame`
        ).toBeGreaterThanOrEqual(200);
      }
    }
  });

  it('holds the same frames at every width', () => {
    // A frame that exists at 200 but not at 80 cannot answer this Issue's
    // question, so the three sets are pinned to each other by name.
    const expected = [...FRAME_NAMES].sort();
    for (const width of WIDTHS) {
      const actual = fs
        .readdirSync(path.join(FIXTURE_DIR, `w${width}`))
        .filter((f) => f.endsWith('.txt'))
        .map((f) => f.replace(/\.txt$/, ''))
        .sort();
      expect(actual, `w${width} does not match the frame list`).toEqual(expected);
    }
  });

  it('was actually captured at the width its directory claims', () => {
    // The whole comparison is worthless if two directories hold the same
    // geometry. `boot-idle` centres opencode's input box, so its widest painted
    // row grows with the pane; measuring the widest VISIBLE row (SGR removed)
    // is enough to tell the three apart without trusting the filename.
    const widest = (raw: string) =>
      Math.max(
        ...raw.split('\n').map((line) => line.replace(/\x1b\[[0-9;]*m/g, '').trimEnd().length)
      );
    for (const width of WIDTHS) {
      const measured = widest(frame(width, 'permission-bash'));
      expect(measured, `w${width} frame is not ${width} columns wide`).toBeLessThanOrEqual(
        width
      );
      expect(measured, `w${width} frame is too narrow to be a ${width}-column capture`)
        .toBeGreaterThan(width - 20);
    }
  });

  it('shows the sidebar at 200 columns and hides it at 80 and 120', () => {
    // The measurement everything below rests on, in the bytes. opencode's
    // sidebar prints a `Context` heading and a token count; neither reaches the
    // pane at all below OPENCODE_SIDEBAR_MIN_WIDTH.
    const hasSidebar = (raw: string) =>
      stripAnsi(raw)
        .split('\n')
        .some((line) => /\bContext\s*$/.test(line.trimEnd()));

    expect(hasSidebar(frame(200, 'turn-complete'))).toBe(true);
    expect(hasSidebar(frame(120, 'turn-complete'))).toBe(false);
    expect(hasSidebar(frame(80, 'turn-complete'))).toBe(false);
    expect(OPENCODE_SIDEBAR_MIN_WIDTH).toBe(121);
  });
});

describe('Issue #2047: 120 columns changes nothing any opencode reader sees', () => {
  it.each(FRAME_NAMES)('reads %s identically at 80 and at 120 columns', (name) => {
    // No expected values on purpose. Both files are live captures of the same
    // instant, so any difference at all is a width dependency — including one
    // this Issue never thought to look for.
    expect(verdictOf(frame(120, name))).toEqual(verdictOf(frame(80, name)));
  });

  it.each(REPLY_PARITY_FRAMES)(
    'saves the same reply glyphs for %s at 80 and at 120',
    (name) => {
    // Prefix, not equality, and the asymmetry is the point: a 200-row window
    // holds more of a long answer once opencode stops wrapping it at 80
    // columns, so the narrow extraction is the wide one cut short. What would
    // be a regression is text APPEARING that the narrow pane never produced —
    // which is exactly what 200 columns does two blocks below.
      const narrow = replyGlyphsOf(frame(80, name));
      const wide = replyGlyphsOf(frame(120, name));
      const [shorter, longer] =
        narrow.length <= wide.length ? [narrow, wide] : [wide, narrow];
      expect(longer.startsWith(shorter), `w120/${name} is not the same reply as w80`).toBe(
        true
      );
    }
  );

  it('leaves the open command palette bleeding into extraction at EVERY width', () => {
    // `command-palette` is excluded from the reply-glyph parity above, and this
    // says why rather than letting the exclusion look like an oversight.
    //
    // An open `ctrl+p` palette is painted OVER the transcript, so
    // `sliceOpenCodeTurn` — which slices rows, not screen regions — takes the
    // palette's item labels along with the response body. That is true at 80
    // columns, i.e. it predates #2047 and is not a sidebar effect; what the
    // width changes is only WHICH palette rows land where, so a prefix
    // relationship between two widths cannot exist and asserting one would be
    // asserting a coincidence.
    //
    // The verdict parity above still covers this frame in full: the palette
    // never makes opencode look `ready`, at any of the three widths.
    for (const width of WIDTHS) {
      const reply = cleanOpenCodeResponse(
        stripAnsi(sliceOpenCodeTurn(frame(width, 'command-palette')))
      );
      // `Write heap snapshot` is a palette command and nothing an essay about
      // the X11 protocol would say. It is the one label visible in all three
      // captures — which item lands in the sliced region is itself a function of
      // the width, and that is the point being made.
      expect(reply, `w${width} palette no longer bleeds`).toContain('Write heap snapshot');
    }
  });

  it('keeps the permission dialog anchored on labels the width does not truncate', () => {
    // OPENCODE_PERMISSION_PATTERN's docblock refuses to anchor on `enter
    // confirm` because opencode truncates it to `enter con` at 80 columns. These
    // captures are the evidence for both halves of that: the hint IS truncated
    // at 80 and whole at 120/200, and the three labels the pattern does use are
    // byte-identical everywhere.
    expect(stripAnsi(frame(80, 'permission-bash'))).toContain('enter con');
    expect(stripAnsi(frame(80, 'permission-bash'))).not.toContain('enter confirm');
    expect(stripAnsi(frame(120, 'permission-bash'))).toContain('enter confirm');
    expect(stripAnsi(frame(200, 'permission-bash'))).toContain('enter confirm');

    for (const width of WIDTHS) {
      expect(
        OPENCODE_PERMISSION_PATTERN.test(stripAnsi(frame(width, 'permission-bash'))),
        `permission dialog stopped matching at ${width} columns`
      ).toBe(true);
    }
  });

  it('reproduces the verdicts #1883 / #1893 / #1894 / #1896 pin, at 80 and 120', () => {
    // The Issue's acceptance condition, spelled as the four suites spell it.
    // These are new captures on 1.18.22 with a different model, so agreeing with
    // the 1.18.20/1.18.21 fixtures is a statement about the detectors rather
    // than about the bytes.
    const expected: Array<[FrameName, string, string]> = [
      // #1883: the placeholder is an input box, not a question.
      ['boot-idle', 'ready', STATUS_REASON.INPUT_PROMPT],
      // #1883: mid-generation footer.
      ['turn-running', 'running', STATUS_REASON.OPENCODE_PROCESSING_INDICATOR],
      // #1883 / #1896: a finished turn closes on a duration-carrying marker.
      ['turn-complete', 'ready', STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      ['numbered-answer', 'ready', STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      // #1883: the phrase inside a response body is not a composer.
      ['phrase-in-response', 'ready', STATUS_REASON.OPENCODE_RESPONSE_COMPLETE],
      // #1893: the permission dialog is a pending decision.
      ['permission-bash', 'waiting', STATUS_REASON.OPENCODE_PERMISSION_PROMPT],
      ['permission-edit', 'waiting', STATUS_REASON.OPENCODE_PERMISSION_PROMPT],
      // #1894: the five-second second-press window is still generating.
      ['esc-again-window', 'running', STATUS_REASON.OPENCODE_PROCESSING_INDICATOR],
    ];

    for (const [name, status, reason] of expected) {
      for (const width of [80, 120] as const) {
        const result = detectSessionStatus(frame(width, name), 'opencode');
        expect(result.status, `w${width}/${name} status`).toBe(status);
        expect(result.reason, `w${width}/${name} reason`).toBe(reason);
        resetDetectPromptCache();
      }
    }
  });

  it('keeps #1894 refusing to complete an interrupted turn at 80 and 120', () => {
    for (const width of [80, 120] as const) {
      const clean = stripAnsi(frame(width, 'double-esc-interrupted'));
      expect(clean, `w${width} lost the interrupted marker`).toContain('· interrupted');
      // `· interrupted` is not a duration, so no completion is claimed — the
      // treatment #1893 gave an aborted turn and #1894 made reachable.
      expect(isOpenCodeComplete(clean), `w${width} completed an interrupted turn`).toBe(
        false
      );
    }
  });

  it('keeps the #1896 command palette out of `ready` at 80 and 120', () => {
    for (const width of [80, 120] as const) {
      const result = detectSessionStatus(frame(width, 'command-palette'), 'opencode');
      expect(result.status, `w${width} palette went ready`).not.toBe('ready');
      expect(result.hasActivePrompt).toBe(false);
      resetDetectPromptCache();
    }
  });
});

describe('Issue #2047: 200 columns is why the default was not raised', () => {
  it('saves the sidebar as the assistant reply', () => {
    // The worst of the four, and the only one that needs nothing from the user:
    // the sidebar occupies the same rows as the reply, so the extractor takes
    // both. At 80 and 120 this turn extracts to the empty string.
    const replyAt = (width: Width) =>
      cleanOpenCodeResponse(stripAnsi(sliceOpenCodeTurn(frame(width, 'phrase-in-response'))));

    expect(replyAt(80)).toBe('');
    expect(replyAt(120)).toBe('');

    const wide = replyAt(200);
    expect(wide).not.toBe('');
    expect(wide).toContain('tokens');
    expect(wide).toContain('LSPs are disabled');
  });

  it('flips an aborted turn from ready to running', () => {
    // Branch D reads a fixed number of CONTENT rows back from the end. The
    // sidebar contributes rows of its own, so the previous turn's
    // `▣ … · 36.1s` — inside the window at 80 and 120 — falls out of it at 200.
    // Same session, same instant, two different answers.
    const statusAt = (width: Width) => {
      resetDetectPromptCache();
      return detectSessionStatus(frame(width, 'turn-aborted-after-complete'), 'opencode');
    };

    expect(statusAt(80).status).toBe('ready');
    expect(statusAt(80).reason).toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
    expect(statusAt(120).status).toBe('ready');
    expect(statusAt(200).status).toBe('running');
    expect(statusAt(200).reason).not.toBe(STATUS_REASON.OPENCODE_RESPONSE_COMPLETE);
  });

  it('lets the session title satisfy the idle-composer anchor', () => {
    // `^\s*┃\s*Ask anything\.\.\.` says "gutter, then the phrase, nothing else
    // between" — which is only a statement about the input box while one row
    // belongs to one pane. At ≥121 columns the sidebar prints the session TITLE
    // to the right of a transcript gutter, and a title carrying the phrase walks
    // straight through the anchor #1883 built.
    for (const name of ['sidebar-title-phrase', 'phrase-in-response', 'numbered-answer'] as const) {
      expect(
        OPENCODE_IDLE_COMPOSER_PATTERN.test(stripAnsi(frame(80, name))),
        `w80/${name} should not look like an idle composer`
      ).toBe(false);
      expect(
        OPENCODE_IDLE_COMPOSER_PATTERN.test(stripAnsi(frame(120, name))),
        `w120/${name} should not look like an idle composer`
      ).toBe(false);
      expect(
        OPENCODE_IDLE_COMPOSER_PATTERN.test(stripAnsi(frame(200, name))),
        `w200/${name} no longer reproduces the sidebar false match`
      ).toBe(true);
    }

    // And the row responsible really is the sidebar's, not a composer: the
    // phrase is the session title, printed far to the right of the gutter.
    const row = stripAnsi(frame(200, 'sidebar-title-phrase'))
      .split('\n')
      .find((line) => OPENCODE_IDLE_COMPOSER_PATTERN.test(line)) as string;
    expect(row).toBeDefined();
    expect(row.indexOf('Ask anything...')).toBeGreaterThan(100);
  });

  it('costs an order of magnitude more bytes per capture', () => {
    // Not a verdict, but the reason a wide pane is not free even where the
    // detectors survive it: the sidebar paints a background across the full
    // width of every row it touches, and `capturePane` runs tmux under a
    // 10 MB `maxBuffer`.
    const bytes = (width: Width) => frame(width, 'phrase-in-response').length;
    expect(bytes(200)).toBeGreaterThan(bytes(80) * 5);
    expect(bytes(120)).toBeLessThan(bytes(80) * 2);
  });

  it('keeps the default below the boundary it measured', () => {
    expect(OPENCODE_PANE_WIDTH).toBeLessThan(OPENCODE_SIDEBAR_MIN_WIDTH);
  });
});
