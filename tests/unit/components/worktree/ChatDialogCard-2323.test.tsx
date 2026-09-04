/**
 * Issue #2323 — the follow was aimed at a row the arrows never move.
 *
 * #2309 shipped the follow and #2318 fixed its arithmetic. Both measured
 * themselves against captures with a selection CARET on them, so neither could
 * see that the caret is not how every TUI marks its selection: Command Code's
 * `/model` picker paints the selected row and carets nothing, and the only
 * caret-shaped row on its frame is the filter box `› Type to search
 * models...`. The follow therefore ran on every keypress, computed a correct
 * pixel offset for row 21, and left `scrollTop` where it was while the
 * selection walked to rows 40, 46 and 54 (UAT 2026-09-04, PC 1440x900).
 *
 * ## What is measured here, and what is constructed
 *
 * The detection cases read committed live captures — `chat-dialog-card-2254`
 * (Issue #2254's raw `capture-pane -p -e` panes at the production 200x1000)
 * and `opencode-live-2049`. Nothing new was captured for this Issue.
 *
 * The geometry cases are pseudo-frames, because jsdom lays nothing out: the
 * scroller's metrics are stubbed and the expected row position is derived from
 * the stub's own constants, exactly as `ChatDialogCard-2318.test.tsx` does. The
 * pseudo-frame is shaped like the Command Code picker on purpose — a caret-
 * bearing filter row near the top and the paint further down — so a rule that
 * went back to reading the caret would fail the MIDDLE and BOTTOM cases here
 * rather than quietly passing on a frame that has only one mark.
 *
 * @vitest-environment jsdom
 */

import fs from 'fs';
import path from 'path';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatDialogCard, findHighlightLineIndex } from '@/components/worktree/ChatDialogCard';
import { extractDialogFrameTail } from '@/lib/chat/dialog-frame';
import { stripAnsi } from '@/lib/detection/ansi';

afterEach(() => {
  cleanup();
});

const ESC = '\x1b[';

/** Command Code's own selected-row background, from the capture. */
const SELECTED_BG = `${ESC}48;2;45;43;85m`;

/**
 * The frame the card really works on.
 *
 * `reason="selectionList"` is what turns the tail slice off (Issue #2309), so
 * the indices below are indices into the WHOLE compacted pane, which is what
 * the component's `useLayoutEffect` measures against.
 */
function cardFrame(fixture: string): string {
  const raw = fs.readFileSync(path.join(process.cwd(), 'tests/fixtures', fixture), 'utf8');
  return extractDialogFrameTail(raw, { selectionList: true });
}

/** The row `findHighlightLineIndex` picked, with its ANSI removed. */
function highlightedRow(frame: string): string | null {
  const index = findHighlightLineIndex(frame);
  return index < 0 ? null : stripAnsi(frame).split('\n')[index];
}

// ---------------------------------------------------------------------------
// Detection — the live Command Code picker
// ---------------------------------------------------------------------------

describe('[#2323] the live Command Code /model capture', () => {
  const frame = cardFrame('chat-dialog-card-2254/command-code-model-1-40-1.txt');

  it('finds the row Command Code painted', () => {
    expect(findHighlightLineIndex(frame)).toBe(26);
    expect(highlightedRow(frame)).toMatch(/^DeepSeek V4 Flash \(latest\) \(default\)/);
  });

  it('does NOT pick the filter row — the row this Issue was stuck on', () => {
    // The regression test. Row 21 is `› Type to search models...`: it is where
    // the caret-only rule landed, and it is a row the arrow keys never move.
    expect(findHighlightLineIndex(frame)).not.toBe(21);
    expect(highlightedRow(frame)).not.toMatch(/Type to search models/);
  });

  it('picks it DESPITE the filter row being caret-shaped', () => {
    // Without this the case above is not a trap at all. The filter row starts
    // with U+203A — the same glyph codex uses as its selection caret — and it
    // is the only caret-shaped row on the whole frame, which is why "caret if
    // there is one, paint otherwise" would not have fixed anything.
    const rows = stripAnsi(frame).split('\n');
    expect(rows[21]).toBe('› Type to search models...');
    expect(rows[21].codePointAt(0)).toBe(0x203a);
    const caretRows = rows.flatMap((row, i) => (/^[^\S\n]*[❯›●][^\S\n]/.test(row) ? [i] : []));
    expect(caretRows).toEqual([21]);
  });

  it('sees nothing at all once the frame is stripped of its ANSI', () => {
    // The mark is a colour, so a frame captured without `-e` has no mark. -1
    // switches the follow off, which is the safe way to be wrong.
    expect(findHighlightLineIndex(stripAnsi(frame))).toBe(21);
    expect(findHighlightLineIndex(stripAnsi(frame).replace(/›/g, ' '))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Detection — nothing about a caret tool changes
// ---------------------------------------------------------------------------

describe('[#2323] the caret tools answer exactly as they did', () => {
  // Every index below was re-derived from the committed bytes on the rule
  // #2309 shipped, before this Issue touched it.
  it.each([
    ['claude 2.1.259 /model', 'chat-dialog-card-2254/claude-model-2-1-259.txt', 9, '❯ 2. Opus'],
    ['claude 2.1.260 /model', 'chat-dialog-card-2254/claude-model-2-1-260.txt', 9, '❯ 2. Opus'],
    ['claude folder trust', 'chat-dialog-card-2254/claude-trust-2-1-259.txt', 14, '❯ No, exit'],
    ['codex 0.151.0 /model', 'chat-dialog-card-2254/codex-model-0-151-0.txt', 23, '› 1. gpt-5.6-sol'],
    ['codex directory trust', 'chat-dialog-card-2254/codex-trust-0-151-0.txt', 5, '› 1. Yes, continue'],
  ])('%s', (_label, fixture, expected, rowStart) => {
    const frame = cardFrame(fixture);
    expect(findHighlightLineIndex(frame)).toBe(expected);
    expect(highlightedRow(frame)?.trim()).toMatch(new RegExp(`^${escapeRegExp(rowStart)}`));
  });

  it('gemini’s ● caret still wins over a painted row above it', () => {
    // The committed gemini capture (`tool-liveness-2070/gemini-dialog-0551
    // .txt`) was taken WITHOUT `-e`, so it carries no colour to test against
    // and its caret sits behind a `│` box gutter the pattern does not accept.
    // This is that dialog's shape with a paint added above it, which is the
    // arrangement the rule has to get right: the caret is lower, so it wins.
    const frame = [
      `${SELECTED_BG}  a painted banner row  ${ESC}0m`,
      '  How would you like to authenticate?',
      '● 1. Sign in with Google',
      '  2. Use Gemini API Key',
    ].join('\n');
    expect(findHighlightLineIndex(frame)).toBe(2);
  });

  it('an opencode overlay at the production pane width still reports nothing', () => {
    // Unchanged, and NOT fixed: at 200 columns opencode paints the whole pane
    // and centres the overlay on it, so the pane's background dominates even
    // the selected row and no row is painted in a colour of its own. Issue
    // #2255's structured picker is what would reach this case.
    expect(findHighlightLineIndex(cardFrame('chat-dialog-card-2254/opencode-agent-overlay-1-18-27.txt'))).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// Detection — which painted row, when several are painted
// ---------------------------------------------------------------------------

describe('[#2323] a panel is not a selection', () => {
  it('ignores Command Code’s seven-row boot banner on the same capture', () => {
    // The banner is rows 3–9 of the picker frame, all `48;2;43;39;88`, and it
    // is the reason the rule is about a row whose neighbours DON'T share its
    // colour rather than about any painted row at all.
    const frame = cardFrame('chat-dialog-card-2254/command-code-model-1-40-1.txt');
    expect(findHighlightLineIndex(frame)).toBeGreaterThan(9);
  });

  it('ignores a block of rows sharing one background', () => {
    const panel = (text: string) => `${ESC}48;2;43;39;88m${text.padEnd(40)}${ESC}0m`;
    const frame = ['  Select model', panel('  banner'), panel('  banner'), panel('  banner')].join(
      '\n',
    );
    expect(findHighlightLineIndex(frame)).toBe(-1);
  });

  it('finds a selection painted INSIDE a panel that is painted too', () => {
    // opencode's command palette: every row of the panel is `48;2;20;20;20`
    // and the highlighted one is `48;2;250;178;131`. A rule that only asked
    // "is this row painted" would answer with the panel's first row.
    const frame = cardFrame('opencode-live-2049/command-palette-11822.txt');
    expect(highlightedRow(frame)?.trim()).toBe('Switch model                                ctrl+x m');
  });

  it('ignores a painted decoration too narrow to be a row', () => {
    // claude paints small cells inside its boot logo — 5 and 6 columns on
    // `claude-model-2-1-259.txt`. They are rejected there by being two rows of
    // one colour; this is the one-row shape, which only the column floor
    // rejects.
    const logo = `${ESC}48;5;16m ▐▛███${ESC}0m  Claude Code v2.1.259`;
    expect(findHighlightLineIndex([`  header`, logo, `  body`].join('\n'))).toBe(-1);

    const wide = `${ESC}48;5;16m ▐▛███▛█ ▝▜██${ESC}0m  Claude Code v2.1.259`;
    expect(findHighlightLineIndex([`  header`, wide, `  body`].join('\n'))).toBe(1);
  });

  it('takes the LAST painted row when a frame carries more than one', () => {
    const row = (text: string) => `${SELECTED_BG}${text.padEnd(30)}${ESC}0m`;
    const frame = ['  Select model', row('  first'), '  between', row('  second')].join('\n');
    expect(findHighlightLineIndex(frame)).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Geometry — the painted row lands inside the visible band
// ---------------------------------------------------------------------------

const FRAME_TESTID = 'chat-dialog-card-frame';

/** The scroller's `p-2`, in pixels — the padding `scrollHeight` also spans. */
const FRAME_PADDING = 8;

/** One row of `text-[11px] leading-snug`, rounded off the UAT's 15.125px. */
const LINE_HEIGHT = 15;

/** Rows in the pseudo-picker — the live command-code `/model` card had 89. */
const TOTAL_LINES = 89;

/** Visible height of the box, as `ChatDialogCard-2318.test.tsx` chose it. */
const CLIENT_HEIGHT = 445;

const SCROLL_HEIGHT = FRAME_PADDING * 2 + TOTAL_LINES * LINE_HEIGHT;

/** Where the filter row sits — above every model row, as Command Code puts it. */
const FILTER_ROW_INDEX = 1;

/**
 * A Command Code-shaped picker: a caret-bearing filter row near the top, and
 * the arrow-selected row marked ONLY by its background.
 */
function paintedPickerFrame(highlightIndex: number): string {
  return Array.from({ length: TOTAL_LINES }, (_value, i) => {
    if (i === 0) return 'Select model';
    if (i === FILTER_ROW_INDEX) return '› Type to search models...';
    const label = `model row ${i}`.padEnd(40);
    return i === highlightIndex ? `${SELECTED_BG}${label}${ESC}0m` : label;
  }).join('\n');
}

/**
 * Give the frame element a real, scrollable layout for the duration of `run`.
 *
 * Same three fakes as `ChatDialogCard-2318.test.tsx`: `scrollHeight` and
 * `clientHeight` on the prototype, so the very first `useLayoutEffect` pass
 * already sees them, and the vertical padding the effect reads out of
 * `getComputedStyle` — delegated for every other property and every other
 * element so nothing else in the render sees a different style object.
 */
function withFrameLayout(run: () => void): void {
  const proto = HTMLElement.prototype;
  const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  const originalClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  const originalGetComputedStyle = window.getComputedStyle;

  Object.defineProperty(proto, 'scrollHeight', { configurable: true, value: SCROLL_HEIGHT });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, value: CLIENT_HEIGHT });
  window.getComputedStyle = ((element: Element, pseudoElement?: string | null) => {
    const real = originalGetComputedStyle.call(window, element, pseudoElement ?? undefined);
    if (!(element instanceof HTMLElement) || element.dataset.testid !== FRAME_TESTID) return real;
    return new Proxy({} as CSSStyleDeclaration, {
      get(_target, property) {
        if (property === 'paddingTop' || property === 'paddingBottom') return `${FRAME_PADDING}px`;
        const value = Reflect.get(real as unknown as Record<string | symbol, unknown>, property);
        return typeof value === 'function' ? value.bind(real) : value;
      },
    });
  }) as typeof window.getComputedStyle;

  try {
    run();
  } finally {
    if (originalScrollHeight) Object.defineProperty(proto, 'scrollHeight', originalScrollHeight);
    if (originalClientHeight) Object.defineProperty(proto, 'clientHeight', originalClientHeight);
    window.getComputedStyle = originalGetComputedStyle;
  }
}

function expectRowFullyInView(frameEl: HTMLElement, rowIndex: number): void {
  const top = FRAME_PADDING + rowIndex * LINE_HEIGHT;
  const bottom = top + LINE_HEIGHT;
  const viewTop = frameEl.scrollTop;
  const viewBottom = viewTop + CLIENT_HEIGHT;
  expect(
    top >= viewTop && bottom <= viewBottom,
    `row ${rowIndex} spans ${top}..${bottom}, visible band is ${viewTop}..${viewBottom}`,
  ).toBe(true);
}

function renderPicker(highlightIndex: number): HTMLElement {
  render(<ChatDialogCard frame={paintedPickerFrame(highlightIndex)} reason="selectionList" />);
  const frameEl = screen.getByTestId(FRAME_TESTID);
  // The whole list is present — no tail slice — so `totalLines` inside the
  // component really is TOTAL_LINES and the geometry above describes it.
  expect(frameEl).toHaveTextContent('model row 2');
  expect(frameEl).toHaveTextContent(`model row ${TOTAL_LINES - 1}`);
  return frameEl;
}

describe('[#2323] the background-marked row lands inside the visible band', () => {
  // The filter row is at index 1, so a rule that still read the caret would
  // clamp `scrollTop` to 0 and pass the TOP case and fail the other two. All
  // three are here for that reason (the same reason #2318 gives: the error
  // grows with the index, so the top of the list is green on the bug).
  it('near the TOP of the list', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderPicker(4), 4);
    });
  });

  it('in the MIDDLE of the list — 46, the UAT’s second miss', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderPicker(46), 46);
    });
  });

  it('at the BOTTOM of the list', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderPicker(TOTAL_LINES - 1), TOTAL_LINES - 1);
    });
  });

  it('moves the scroll as the paint moves, which is what stood still', () => {
    withFrameLayout(() => {
      const { rerender } = render(
        <ChatDialogCard frame={paintedPickerFrame(40)} reason="selectionList" />,
      );
      const frameEl = screen.getByTestId(FRAME_TESTID);
      const positions: number[] = [frameEl.scrollTop];
      for (const index of [46, 54, 70]) {
        rerender(<ChatDialogCard frame={paintedPickerFrame(index)} reason="selectionList" />);
        expectRowFullyInView(frameEl, index);
        positions.push(frameEl.scrollTop);
      }
      // The UAT's signature was `scrollTop` reading 231 on every one of these.
      expect(new Set(positions).size).toBe(positions.length);
    });
  });
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
