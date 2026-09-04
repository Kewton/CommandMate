/**
 * Issue #2326 — the follow, run on the frame the card actually draws.
 *
 * #2318 fixed WHERE row `i` is and #2323 fixed WHICH row `i` is, and both were
 * measured on frames that were mostly dialog. This Issue's frame is not: a
 * Command Code session with five turns behind it hands the card 333 rows of
 * which 256 are banner and transcript, and the card drew all of them. The
 * highlight was found correctly and scrolled to correctly — into a box whose
 * visible thirty rows were the previous answers, with the picker below the
 * fold.
 *
 * So the fix is a crop (`dialog-frame-2326.test.ts`), and what is measured HERE
 * is that the crop is enough: with the card holding 76 rows instead of 333, the
 * rule #2323 shipped and the arithmetic #2318 shipped put the arrow-selected
 * row inside the visible band without either of them changing.
 *
 * ## Live captures, three real arrow positions
 *
 * Command Code 1.47.1, 2026-09-05, private socket, 200x1000 — the four states
 * `dialog-frame-2326.test.ts` documents. The three picker states are the SAME
 * session with the arrows in three places, so the frames differ only in which
 * row carries `48;2;45;43;85`, and the three land in the three regimes the
 * follow has: no scroll (clamped at 0), a scroll strictly inside the range, and
 * a scroll clamped at the maximum. #2318 and #2323 both note why one position
 * is not a test — the error grows with the index, so the top of the list is
 * green on the bug.
 *
 * The geometry is stubbed exactly as `ChatDialogCard-2318.test.tsx` and
 * `ChatDialogCard-2323.test.tsx` stub it (jsdom lays nothing out), with the box
 * height set to the 315px `max-h-[35vh]` is on a 900px window — the cap Issue
 * #2326 gives a selection list on the surface.
 *
 * @vitest-environment jsdom
 */

import fs from 'node:fs';
import path from 'node:path';
import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatDialogCard, findHighlightLineIndex } from '@/components/worktree/ChatDialogCard';
import { extractDialogFrameTail } from '@/lib/chat/dialog-frame';
import { stripAnsi } from '@/lib/detection/ansi';

afterEach(() => {
  cleanup();
});

const FRAME_TESTID = 'chat-dialog-card-frame';
const DIR = path.resolve(__dirname, '../../../fixtures/chat-dialog-card-2254');

/** The scroller's `p-2`, in pixels — the padding `scrollHeight` also spans. */
const FRAME_PADDING = 8;

/** One row of `text-[11px] leading-snug`, rounded off the UAT's 15.125px. */
const LINE_HEIGHT = 15;

/** `max-h-[35vh]` on a 900px window, which is the cap Issue #2326 sets. */
const CLIENT_HEIGHT = 315;

function fixture(name: string): string {
  return fs.readFileSync(path.join(DIR, `command-code-model-1-47-1-${name}.txt`), 'utf8');
}

/** The frame the card really renders — cropped, because it is a selection list. */
function cardFrame(name: string): string {
  return extractDialogFrameTail(fixture(name), { selectionList: true });
}

/**
 * The three states, the model the arrows are on, and where that row sits in the
 * 76-row card. Every number is read off the committed bytes, not chosen.
 */
const STATES = [
  ['open', 'DeepSeek V4 Flash (latest) (default)', 8],
  ['middle', 'Tencent Hy4 Preview', 40],
  ['bottom', 'Grok 4.6', 73],
] as const;

/**
 * Give the frame element a real, scrollable layout for the duration of `run`.
 *
 * The same three fakes `ChatDialogCard-2318.test.tsx` uses: `scrollHeight` and
 * `clientHeight` on the prototype, so the very first `useLayoutEffect` pass
 * already sees them, and the vertical padding the effect reads out of
 * `getComputedStyle` — delegated for every other property and every other
 * element so nothing else in the render sees a different style object.
 *
 * `scrollHeight` is derived from the frame's OWN row count rather than a
 * constant, because the row count is the thing this Issue changed.
 */
function withFrameLayout(totalLines: number, run: () => void): void {
  const proto = HTMLElement.prototype;
  const originalScrollHeight = Object.getOwnPropertyDescriptor(proto, 'scrollHeight');
  const originalClientHeight = Object.getOwnPropertyDescriptor(proto, 'clientHeight');
  const originalGetComputedStyle = window.getComputedStyle;

  Object.defineProperty(proto, 'scrollHeight', {
    configurable: true,
    value: FRAME_PADDING * 2 + totalLines * LINE_HEIGHT,
  });
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

// ---------------------------------------------------------------------------
// Detection — the crop did not cost the highlight
// ---------------------------------------------------------------------------

describe('[#2326] the arrow-selected row is still found after the crop', () => {
  it.each(STATES)('%s → %s at index %d', (name, label, index) => {
    const frame = cardFrame(name);
    expect(findHighlightLineIndex(frame)).toBe(index);
    expect(stripAnsi(frame).split('\n')[index]).toMatch(
      new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  });

  it('does not pick the filter row, which the crop moved but did not remove', () => {
    // `› Type to search models...` is row 3 of the cropped card and is still
    // the only caret-shaped row on it — Issue #2323's trap, re-derived here
    // because a crop that had dropped the filter box would have made #2323's
    // rule untestable on this frame rather than satisfied by it.
    for (const [name] of STATES) {
      const rows = stripAnsi(cardFrame(name)).split('\n');
      expect(rows[3], name).toBe('› Type to search models...');
      const carets = rows.flatMap((row, i) => (/^[^\S\n]*[❯›●][^\S\n]/.test(row) ? [i] : []));
      expect(carets, name).toEqual([3]);
      expect(findHighlightLineIndex(cardFrame(name)), name).not.toBe(3);
    }
  });

  it('is the CROP that made this reachable, not a change to the rule', () => {
    // The positive control for the whole file. On the uncropped frame the same
    // rule finds the same physical row — it was never wrong — but that row is
    // index 265 of a 333-row card, and the five `❯ …` prompt rows above it
    // carry the same `48;2;45;43;85` background the picker paints its
    // selection in. Nothing here is a claim about `findHighlightLineIndex`;
    // the claim is that 8, 40 and 73 of 76 are positions a 360px box can show
    // and 265, 297 and 330 of 333 are not.
    const raw = fixture('open').replace(/\r\n/g, '\n');
    expect(findHighlightLineIndex(raw)).toBe(265);
    const paintedRows = raw
      .split('\n')
      .flatMap((row, i) => (row.includes('48;2;45;43;85') ? [i] : []));
    expect(paintedRows).toEqual([17, 72, 137, 200, 206, 265]);
    expect(stripAnsi(raw).split('\n')[17]).toMatch(/^❯ List the numbers 1 to 50/);
  });
});

// ---------------------------------------------------------------------------
// Geometry — all three positions land inside the visible band
// ---------------------------------------------------------------------------

describe('[#2326] the highlight lands inside the card’s visible band', () => {
  it.each(STATES)('%s → %s at index %d of 76', (name, _label, index) => {
    const frame = cardFrame(name);
    const totalLines = stripAnsi(frame).split('\n').length;
    expect(totalLines).toBe(76);

    withFrameLayout(totalLines, () => {
      render(<ChatDialogCard frame={fixture(name)} reason="selectionList" />);
      const frameEl = screen.getByTestId(FRAME_TESTID);
      // The card really is the picker: its first and last rows are the
      // dialog's, so `totalLines` above describes what is on screen.
      expect(frameEl).toHaveTextContent('Select model');
      expect(frameEl).toHaveTextContent('Grok 4.6');
      expectRowFullyInView(frameEl, index);
    });
  });

  it('uses all three regimes of the scroll, so no one of them carries the suite', () => {
    // Stated as a measurement rather than left implicit: `open` is clamped at
    // 0, `middle` is strictly inside the range, `bottom` is clamped at the
    // maximum. A follow that only ever wrote 0 would pass the first case, and
    // one that always jumped to the end would pass the third.
    const totalLines = 76;
    const scrollable = FRAME_PADDING * 2 + totalLines * LINE_HEIGHT - CLIENT_HEIGHT;
    const positions: number[] = [];
    withFrameLayout(totalLines, () => {
      for (const [name] of STATES) {
        cleanup();
        render(<ChatDialogCard frame={fixture(name)} reason="selectionList" />);
        positions.push(screen.getByTestId(FRAME_TESTID).scrollTop);
      }
    });
    expect(positions[0]).toBe(0);
    expect(positions[1]).toBeGreaterThan(0);
    expect(positions[1]).toBeLessThan(scrollable);
    expect(positions[2]).toBe(scrollable);
  });

  it('moves as the arrows move, which is what stood still', () => {
    // The Issue's own signature: twelve ▼ and the visible band never left
    // rows 259..288. Re-rendering the card with the next captured state has to
    // move `scrollTop` every time.
    withFrameLayout(76, () => {
      const { rerender } = render(
        <ChatDialogCard frame={fixture('open')} reason="selectionList" />,
      );
      const frameEl = screen.getByTestId(FRAME_TESTID);
      const seen: number[] = [frameEl.scrollTop];
      for (const [name, , index] of STATES.slice(1)) {
        rerender(<ChatDialogCard frame={fixture(name)} reason="selectionList" />);
        expectRowFullyInView(frameEl, index);
        seen.push(frameEl.scrollTop);
      }
      expect(new Set(seen).size).toBe(seen.length);
    });
  });
});

// ---------------------------------------------------------------------------
// The card never goes blank
// ---------------------------------------------------------------------------

describe('[#2326] a frame with no picker on it still renders', () => {
  it('draws the pane after Escape rather than nothing', () => {
    // The fallback, from the component's side: the surface can still be
    // holding `selectionList` from the previous poll when the pane no longer
    // has a dialog on it, and an empty dark box is worse than too many rows.
    withFrameLayout(258, () => {
      render(<ChatDialogCard frame={fixture('closed')} reason="selectionList" />);
      const frameEl = screen.getByTestId(FRAME_TESTID);
      expect(frameEl).toHaveTextContent('Ask your question');
      expect(frameEl.textContent?.trim()).not.toBe('');
    });
  });
});
