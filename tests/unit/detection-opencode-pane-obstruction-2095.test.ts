/**
 * Issue #2095: seeing that opencode's sidebar is on, from the frame alone.
 *
 * ## What was measured, and by whom
 *
 * Nothing new was captured for this Issue. Its evidence is the fixture pair
 * Issue #2046 committed — `w80/sidebar-off.txt` and `w80/sidebar-on.txt`, the
 * SAME live opencode 1.18.22 session one `ctrl+x b` apart at the 80 columns
 * production runs opencode at — plus the three-width set #2047 committed.
 * `tests/unit/detection-opencode-quick-key-frames-2046.test.ts` already runs the
 * pair through the real detectors; this suite re-runs the parts #2095 depends on
 * as its own controls rather than trusting a summary of them, and every number
 * below was re-derived from the committed bytes on 2026-08-27.
 *
 * The re-derivation agreed with #2046 on the verdicts (`ready` /
 * `opencode_response_complete` / complete → `running` / `unknown_frame` /
 * incomplete) and with #2047 on the 121-column boundary. It disagreed with the
 * Issue text on one point, and the measurement wins: the Issue says
 * `commandmate wait` never returns. It does return. `running` / `unknown_frame`
 * raises `isUnclassifiedActive`, and `wait` has stopped on that since #1708 —
 * exit 10, `type: unclassified`, after a 60 s dwell. The verdict was never
 * wrong; what was missing was the CAUSE, which is why this Issue adds a cause to
 * messages instead of adding an exit code. See the docblock on
 * `CurrentOutputPayload.paneObstruction`.
 *
 * ## Why the rule is geometry and not a word list
 *
 * `Context`, `LSP` and `tokens` are on opencode's sidebar. They are also
 * ordinary English an agent writes in a reply, and `WORD_LIST_TRAP` below is a
 * frame that says all three inside the transcript with no sidebar anywhere. A
 * word list flags it. The published rule does not, because what it reads is that
 * the input box's bottom border stops short of the pane and rows that belong to
 * the box carry text past its edge.
 *
 * @vitest-environment node
 */

import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import {
  detectOpenCodePaneObstruction,
  OPENCODE_SIDEBAR_OBSTRUCTION_ID,
  OPENCODE_SIDEBAR_RECOVERY_CHORD,
  OPENCODE_SIDEBAR_MIN_ROWS,
  OPENCODE_SIDEBAR_EXCERPT_MAX_BYTES,
  OPENCODE_SIDEBAR_TRUNCATION_MARKER,
} from '@/lib/detection/opencode-pane-obstruction';
import { detectSessionStatus } from '@/lib/detection/status-detector';
import { resetDetectPromptCache } from '@/lib/detection/prompt-detector';
import {
  stripAnsi,
  OPENCODE_COMPOSER_BOTTOM_BORDER,
  OPENCODE_GUTTER_ROW_PATTERN,
} from '@/lib/detection/cli-patterns';
import { isOpenCodeComplete } from '@/lib/response-extractor';
import { OPENCODE_PANE_WIDTH, OPENCODE_SIDEBAR_MIN_WIDTH } from '@/config/tmux-pane-config';

const DIR_2046 = path.resolve(__dirname, '../fixtures/opencode-live-2046/w80');
const DIR_2047 = path.resolve(__dirname, '../fixtures/opencode-live-2047');

function frame2046(name: string): string {
  return fs.readFileSync(path.join(DIR_2046, `${name}.txt`), 'utf-8');
}

function frame2047(width: 'w80' | 'w120' | 'w200', name: string): string {
  return fs.readFileSync(path.join(DIR_2047, width, `${name}.txt`), 'utf-8');
}

/** The 100 rows the server judges `paneObstruction` on, and publishes. */
function realtimeSnippet(raw: string): string {
  return raw.split('\n').slice(-100).join('\n');
}

/** Every #2046 frame except the one with the sidebar on. */
const CONTROL_FRAMES_2046 = [
  'agent-build',
  'agent-plan',
  'dialog-agent-list',
  'dialog-command-palette',
  'dialog-session-list',
  'dialog-timeline',
  'home-idle',
  'home-leader-b-fallthrough',
  'sidebar-off',
] as const;

/** #2047's frames that carry a composer box at every width. */
const WIDTH_FRAMES_2047 = [
  'boot-idle',
  'command-palette',
  'composer-residual',
  'double-esc-interrupted',
  'esc-again-window',
  'numbered-answer',
  'phrase-in-response',
  'sidebar-title-phrase',
  'turn-aborted-after-complete',
  'turn-complete',
  'turn-running',
] as const;

/**
 * `sidebar-off` with the sidebar's most quotable words moved INTO the
 * transcript, on SEVERAL rows, where an agent asked about LSPs would put them.
 *
 * Built by substituting inside the REAL frame — same escape sequences, same
 * 5-column transcript indent, same total row count, still far inside the
 * 80-column pane — rather than hand-writing one, so the geometry is byte-for-
 * byte the control's and the only difference is the words.
 *
 * **Several rows, not one, and that is the whole point.** The published rule
 * needs {@link OPENCODE_SIDEBAR_MIN_ROWS} rows before it will call something a
 * column, so a one-row trap is passed by a word-list implementation too and
 * proves nothing. Verified by mutation on 2026-08-27: replacing the geometry
 * rule with `/Context|LSPs? |tokens/` over every row leaves a one-row trap
 * green and turns this one red.
 *
 * The reply row is found by its bytes and its two neighbours are asserted blank
 * before being written to, so a future re-capture that moves the reply fails
 * loudly instead of quietly testing nothing.
 */
const REPLY_ROW = '\u001b[38;2;238;238;238mOK2046\u001b[38;2;255;255;255m';

function wordListTrap(): string {
  const lines = frame2046('sidebar-off').split('\n');
  const replyAt = lines.findIndex((l) => l.includes(REPLY_ROW));
  expect(replyAt).toBeGreaterThan(0);
  expect(lines[replyAt - 1]).toBe('');
  expect(lines[replyAt + 1]).toBe('');

  const say = (text: string) => `     \u001b[38;2;238;238;238m${text}\u001b[38;2;255;255;255m`;
  lines[replyAt - 1] = say('Context: the LSPs are disabled in this repo, so');
  lines[replyAt] = say('nothing indexes it. That saves about 8,498 tokens');
  lines[replyAt + 1] = say('per turn — roughly 1% used of the LSP budget.');
  return lines.join('\n');
}

beforeEach(() => {
  resetDetectPromptCache();
});

describe('Issue #2095 acceptance: the sidebar is visible in the frame', () => {
  it('raises a signal on `w80/sidebar-on.txt`', () => {
    const match = detectOpenCodePaneObstruction(frame2046('sidebar-on'));

    expect(match).not.toBeNull();
    expect(match?.id).toBe(OPENCODE_SIDEBAR_OBSTRUCTION_ID);
    expect(match?.id).toBe('opencode_sidebar');
  });

  it('does NOT raise it on `w80/sidebar-off.txt` — the same session, one keystroke earlier', () => {
    expect(detectOpenCodePaneObstruction(frame2046('sidebar-off'))).toBeNull();
  });

  it('reports the box edge and the row count it decided on', () => {
    const match = detectOpenCodePaneObstruction(frame2046('sidebar-on'));

    // Measured 2026-08-27 off the committed bytes: `ctrl+x b` cuts the input box
    // from the full 78 columns of the 80-column pane down to 38, and five of the
    // box's rows then carry a second column.
    expect(match?.boxRight).toBe(38);
    expect(match?.rows).toBe(5);
    // The control's box owns the pane, which is why nothing can sit past it.
    const off = stripAnsi(frame2046('sidebar-off'))
      .split('\n')
      .find((l) => OPENCODE_COMPOSER_BOTTOM_BORDER.test(l));
    expect(off).toHaveLength(78);
  });

  it('carries the second column’s own text as the excerpt', () => {
    const match = detectOpenCodePaneObstruction(frame2046('sidebar-on'));

    // The sidebar's top row is the session TITLE, which for this fixture is the
    // word the turn was asked to reply with. That is the sidebar talking, not
    // the transcript — #2047 measured the same row carrying a title.
    expect(match?.matchedText).toBe('OK2046');
  });

  it('still sees it in the 100 rows the payload publishes', () => {
    // The server judges `realtimeSnippet`, not the whole capture, so that an
    // operator can check the claim against the rows printed next to it. Two of
    // the five evidence rows are older than that window; the guard needs
    // OPENCODE_SIDEBAR_MIN_ROWS and the window holds more than that.
    const match = detectOpenCodePaneObstruction(realtimeSnippet(frame2046('sidebar-on')));

    expect(match).not.toBeNull();
    expect(match?.rows).toBe(3);
    expect(match?.rows).toBeGreaterThanOrEqual(OPENCODE_SIDEBAR_MIN_ROWS);
  });

  it('names the keystroke that closes it, in opencode’s own spelling', () => {
    // Not invented here: opencode's `ctrl+p` palette prints its own keybind
    // table, and this fixture is that table on a live TUI.
    expect(stripAnsi(frame2046('dialog-command-palette'))).toContain('Show sidebar');
    const row = stripAnsi(frame2046('dialog-command-palette'))
      .split('\n')
      .find((l) => l.includes('Show sidebar'));
    expect(row).toContain(OPENCODE_SIDEBAR_RECOVERY_CHORD);
  });
});

describe('Issue #2095: the control frames stay silent', () => {
  it.each(CONTROL_FRAMES_2046)('%s raises nothing', (name) => {
    expect(detectOpenCodePaneObstruction(frame2046(name))).toBeNull();
  });

  it('leaves `sidebar-off`’s published verdicts exactly where #2046 measured them', () => {
    // The acceptance condition this Issue must not break. Restated here rather
    // than left to the #2046 suite because a change to the detection layer that
    // moved them would make this Issue's own control meaningless.
    const off = frame2046('sidebar-off');
    const status = detectSessionStatus(off, 'opencode');

    expect(status.status).toBe('ready');
    expect(status.reason).toBe('opencode_response_complete');
    expect(isOpenCodeComplete(stripAnsi(off))).toBe(true);
  });

  it('does not read the words — a transcript that says Context / tokens / LSP is clean', () => {
    const trap = wordListTrap();
    const clean = stripAnsi(trap);

    // All three sidebar words are on the frame, on three separate rows — more
    // rows than OPENCODE_SIDEBAR_MIN_ROWS, so a word list would fire.
    for (const word of ['Context', 'tokens', 'LSP']) {
      expect(clean).toContain(word);
    }
    expect(clean.split('\n').filter((l) => /Context|LSPs? |tokens/.test(l)).length).toBe(3);
    // …and the frame is still one column, so nothing is raised.
    expect(detectOpenCodePaneObstruction(trap)).toBeNull();
    // The trap really is the control frame plus words: same geometry, same
    // verdicts. Without this the test above could pass because the substitution
    // broke the box rather than because the rule is structural.
    expect(detectSessionStatus(trap, 'opencode').status).toBe('ready');
  });
});

describe('Issue #2095: the rule is geometry, not pane width', () => {
  it('fires at the default 80 columns, below the width the sidebar appears at on its own', () => {
    // #2046's finding, and the reason a width branch would have missed this
    // entirely: the explicit toggle ignores the threshold #2047 measured.
    expect(OPENCODE_PANE_WIDTH).toBe(80);
    expect(OPENCODE_PANE_WIDTH).toBeLessThan(OPENCODE_SIDEBAR_MIN_WIDTH);
    expect(detectOpenCodePaneObstruction(frame2046('sidebar-on'))).not.toBeNull();
  });

  it.each(WIDTH_FRAMES_2047)(
    '%s: silent at 80 and 120 columns, raised at 200 — the same session resized',
    (name) => {
      expect(detectOpenCodePaneObstruction(frame2047('w80', name))).toBeNull();
      expect(detectOpenCodePaneObstruction(frame2047('w120', name))).toBeNull();

      // #2047 captured `boot-idle` and `composer-residual` on opencode's HOME
      // screen, where there is no session yet and therefore no sidebar — at 200
      // columns those two are a centred box with empty space either side, which
      // is a narrow box that is NOT a second column. Everything else in the set
      // has a session, and at 200 columns every one of them is in two columns.
      const homeScreen = name === 'boot-idle' || name === 'composer-residual';
      expect(detectOpenCodePaneObstruction(frame2047('w200', name))).toStrictEqual(
        homeScreen ? null : expect.objectContaining({ id: OPENCODE_SIDEBAR_OBSTRUCTION_ID }),
      );
    },
  );
});

describe('Issue #2095: null is "could not read the layout", never "the sidebar is off"', () => {
  it.each(['w80', 'w120', 'w200'] as const)(
    '%s permission dialogs answer null because they remove the border row',
    (width) => {
      for (const name of ['permission-bash', 'permission-edit']) {
        const raw = frame2047(width, name);
        // The premise: no bottom border anywhere on these frames.
        expect(
          stripAnsi(raw).split('\n').some((l) => OPENCODE_COMPOSER_BOTTOM_BORDER.test(l)),
        ).toBe(false);
        expect(detectOpenCodePaneObstruction(raw)).toBeNull();
      }
    },
  );

  it('answers null on a frame with no opencode box at all', () => {
    expect(detectOpenCodePaneObstruction('')).toBeNull();
    expect(detectOpenCodePaneObstruction('❯ just a shell prompt\n')).toBeNull();
  });
});

describe('Issue #2095: the anchors are the ones cli-patterns already publishes', () => {
  it('selects the same border rows as OPENCODE_COMPOSER_BOTTOM_BORDER', () => {
    // The module restates that pattern with capture groups because it needs the
    // border's COLUMN. This is the guard against the restatement drifting: run
    // both over every committed opencode frame and require row-for-row
    // agreement.
    const local = /^([^\S\n]*)╹(▀{4,})/;
    const files = [
      ...CONTROL_FRAMES_2046.map((n) => frame2046(n)),
      frame2046('sidebar-on'),
      ...(['w80', 'w120', 'w200'] as const).flatMap((w) =>
        WIDTH_FRAMES_2047.map((n) => frame2047(w, n)),
      ),
    ];

    let borderRows = 0;
    for (const raw of files) {
      for (const line of stripAnsi(raw).split('\n')) {
        const shared = OPENCODE_COMPOSER_BOTTOM_BORDER.test(line);
        expect(local.test(line)).toBe(shared);
        if (shared) borderRows += 1;
      }
    }
    // A positive control: agreement on zero rows would prove nothing.
    expect(borderRows).toBeGreaterThan(0);
  });

  it('selects the same gutter rows as OPENCODE_GUTTER_ROW_PATTERN', () => {
    const local = /^([^\S\n]*)[│┃]/;
    let gutterRows = 0;
    for (const line of stripAnsi(frame2046('sidebar-on')).split('\n')) {
      const shared = OPENCODE_GUTTER_ROW_PATTERN.test(line);
      expect(local.test(line)).toBe(shared);
      if (shared) gutterRows += 1;
    }
    expect(gutterRows).toBeGreaterThan(0);
  });
});

describe('Issue #2095: the cut is a terminal column, not a UTF-16 index', () => {
  /**
   * A full-width box whose composer holds text made almost entirely of
   * combining marks.
   *
   * Not a captured frame — no committed capture has one, and this is the case a
   * capture would not show until a user typing Thai, Devanagari, Hebrew with
   * nikud or macOS's NFD Latin met it. Each visible character carries two marks,
   * so the row is three times longer in UTF-16 units than it is wide on screen,
   * and a naive `slice(boxRight)` finds a "second column" that is really the
   * back third of the user's own sentence.
   */
  function combiningComposer(rows: number): string {
    const glyph = 'e\u0301\u0302'; // one column, three UTF-16 units
    const boxWidth = 78;
    const text = glyph.repeat(40); // 40 columns, 120 units — well inside the box
    const body = Array.from({ length: rows }, () => `  ┃  ${text}`);
    return [...body, `  ╹${'▀'.repeat(boxWidth - 3)}`].join('\n');
  }

  it('does not invent a column out of zero-width marks', () => {
    const frame = combiningComposer(4);

    // The premise: every composer row IS longer in units than the box is wide,
    // which is exactly what a UTF-16 cut would mistake for a second column.
    for (const line of frame.split('\n').filter((l) => l.includes('┃'))) {
      expect(line.length).toBeGreaterThan(78);
    }
    expect(detectOpenCodePaneObstruction(frame)).toBeNull();
  });

  it('still finds a real column on the same geometry', () => {
    // The positive control for the test above: pad those same rows out to the
    // box's right edge — 5 columns of gutter plus 40 of glyphs is 45, so 33
    // spaces reach 78 — and put an actual second column past it. Reported.
    // Without this, "returns null" above could mean the synthetic frame is
    // unreadable rather than that the marks were handled.
    const withColumn = combiningComposer(4)
      .split('\n')
      .map((l) => (l.includes('┃') ? `${l}${' '.repeat(33)}  Context` : l))
      .join('\n');

    expect(detectOpenCodePaneObstruction(withColumn)?.matchedText).toBe('Context');
    expect(detectOpenCodePaneObstruction(withColumn)?.rows).toBe(4);
  });
});

describe('Issue #2095: the excerpt is bounded in bytes', () => {
  it('truncates a long second column on a code-point boundary', () => {
    // A synthetic frame, because no captured pane carries a 200-byte sidebar
    // cell: the bound has to be exercised somewhere, and the geometry it is
    // exercised through is the real one.
    const wide = 'あ'.repeat(200);
    const box = '  ┃'.padEnd(38, ' ');
    const raw = [
      `${box}  ${wide}`,
      `${box}  ${wide}`,
      `  ╹${'▀'.repeat(35)}  ${wide}`,
    ].join('\n');

    const match = detectOpenCodePaneObstruction(raw);

    expect(match).not.toBeNull();
    expect(match?.matchedText.endsWith(OPENCODE_SIDEBAR_TRUNCATION_MARKER)).toBe(true);
    expect(new TextEncoder().encode(match?.matchedText ?? '').length).toBeLessThanOrEqual(
      OPENCODE_SIDEBAR_EXCERPT_MAX_BYTES,
    );
    // Whole code points only: a cut inside a 3-byte character would round-trip
    // through JSON as U+FFFD.
    expect(match?.matchedText).not.toContain('�');
  });

  it('needs more than one row before it will call it a column', () => {
    const box = '  ┃'.padEnd(38, ' ');
    const oneRow = [box, `${box}  Context`, `  ╹${'▀'.repeat(35)}`].join('\n');

    expect(detectOpenCodePaneObstruction(oneRow)).toBeNull();
    expect(OPENCODE_SIDEBAR_MIN_ROWS).toBe(2);
  });
});
