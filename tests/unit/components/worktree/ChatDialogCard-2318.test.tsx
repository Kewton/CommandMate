/**
 * Issue #2318 — the highlight follow #2309 shipped never put the highlighted
 * row inside the card's visible band.
 *
 * #2309's effect placed row `i` at `(i / (totalLines - 1)) * (scrollHeight -
 * clientHeight)`. Row `i` is actually `i` rows down a stack of `totalLines`
 * rows, i.e. a fraction of the CONTENT height, so every position came out
 * compressed by `scrollable / scrollHeight` — on the live `/model` card that
 * factor was 765/1211 = 0.63 and the UAT found the marker 155px below the
 * bottom of the box on all five sampled keypresses.
 *
 * `ChatDialogCard-2309.test.tsx` asserts that the effect MOVES the scroll
 * (`scrollTop > 0`), which the broken arithmetic satisfies too. This file
 * asserts the property that actually matters — the row lands inside
 * `scrollTop .. scrollTop + clientHeight` — at the TOP, MIDDLE and BOTTOM of
 * the list. All three positions are load-bearing: the error grows with the
 * index, so the top row is in view under the old formula as well and a suite
 * that only looked there would be green on the bug.
 *
 * Every number below is a pseudo-frame: jsdom lays nothing out, so the box's
 * geometry is stubbed onto `HTMLElement.prototype` (see `withFrameLayout`) and
 * the expected row position is derived from the stub's own `LINE_HEIGHT` and
 * `FRAME_PADDING` constants rather than from the component's formula, so the
 * assertions cannot agree with the implementation by construction.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatDialogCard } from '@/components/worktree/ChatDialogCard';

afterEach(() => {
  cleanup();
});

const FRAME_TESTID = 'chat-dialog-card-frame';

/** The scroller's `p-2`, in pixels — the padding `scrollHeight` also spans. */
const FRAME_PADDING = 8;

/** One row of `text-[11px] leading-snug`, rounded off the UAT's 15.125px. */
const LINE_HEIGHT = 15;

/** Rows in the pseudo-list — the live command-code `/model` card had 79. */
const TOTAL_LINES = 80;

/**
 * Visible height of the box. Odd on purpose: it makes `(clientHeight -
 * lineHeight) / 2` a whole number so the middle case can be pinned to an exact
 * `scrollTop` without depending on how jsdom stores a fractional one.
 *
 * With the constants above the pseudo-frame is 1216px of content in a 445px
 * box — 771px of scroll, within a pixel or two of the 1211/446/765 the UAT
 * measured on the real card.
 */
const CLIENT_HEIGHT = 445;

const SCROLL_HEIGHT = FRAME_PADDING * 2 + TOTAL_LINES * LINE_HEIGHT;

/** A `TOTAL_LINES`-row picker with the caret on exactly one row. */
function selectionListFrame(highlightIndex: number): string {
  return Array.from({ length: TOTAL_LINES }, (_value, i) =>
    i === highlightIndex ? `❯ model row ${i}` : `  model row ${i}`,
  ).join('\n');
}

/**
 * Give the frame element a real, scrollable layout for the duration of `run`.
 *
 * Three reads have to be faked, all of which jsdom answers with `0`:
 * `scrollHeight` and `clientHeight` (patched on the prototype so the very
 * first `useLayoutEffect` pass, which runs during `render`, already sees them)
 * and the vertical padding, which the effect takes from `getComputedStyle`.
 * The `getComputedStyle` stand-in delegates every property except the two
 * paddings, and only for the frame element, so nothing else in the render —
 * React, RTL, jest-dom — sees a different style object than it otherwise would.
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

/** Where the pseudo-frame puts row `i`, straight from the stub's constants. */
function rowBand(rowIndex: number): { top: number; bottom: number } {
  const top = FRAME_PADDING + rowIndex * LINE_HEIGHT;
  return { top, bottom: top + LINE_HEIGHT };
}

function expectRowFullyInView(frameEl: HTMLElement, rowIndex: number): void {
  const { top, bottom } = rowBand(rowIndex);
  const viewTop = frameEl.scrollTop;
  const viewBottom = viewTop + CLIENT_HEIGHT;
  expect(
    top >= viewTop && bottom <= viewBottom,
    `row ${rowIndex} spans ${top}..${bottom}, visible band is ${viewTop}..${viewBottom}`,
  ).toBe(true);
}

function renderFrame(highlightIndex: number): HTMLElement {
  render(<ChatDialogCard frame={selectionListFrame(highlightIndex)} reason="selectionList" />);
  const frameEl = screen.getByTestId(FRAME_TESTID);
  // The whole list is present — no tail slice — so `totalLines` inside the
  // component really is TOTAL_LINES and the geometry above describes it.
  expect(frameEl).toHaveTextContent('model row 0');
  expect(frameEl).toHaveTextContent(`model row ${TOTAL_LINES - 1}`);
  return frameEl;
}

describe('[#2318] the highlighted row lands inside the visible band', () => {
  // The top row is the position #2309's formula got right by accident (its
  // target clamps to 0 there just as the correct one does), so it is here to
  // pin that the fix did not break the easy end — not as evidence of the fix.
  it('near the TOP of the list', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderFrame(2), 2);
    });
  });

  it('in the MIDDLE of the list', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderFrame(40), 40);
    });
  });

  it('at the BOTTOM of the list — the position the UAT measured 155px out', () => {
    withFrameLayout(() => {
      expectRowFullyInView(renderFrame(TOTAL_LINES - 1), TOTAL_LINES - 1);
    });
  });

  it('stays in view across four arrow presses, as the Issue’s ▼ x4 did', () => {
    withFrameLayout(() => {
      const { rerender } = render(
        <ChatDialogCard frame={selectionListFrame(70)} reason="selectionList" />,
      );
      const frameEl = screen.getByTestId(FRAME_TESTID);
      for (let index = 71; index <= 74; index += 1) {
        rerender(<ChatDialogCard frame={selectionListFrame(index)} reason="selectionList" />);
        expectRowFullyInView(frameEl, index);
      }
    });
  });
});

describe('[#2318] the computed scroll position', () => {
  it('centres the row, offset by the scroller’s own top padding', () => {
    withFrameLayout(() => {
      const frameEl = renderFrame(40);
      // 8 + 40*15 = 608 (the row's top) − (445 − 15)/2 = 215 (half a box, less
      // half a row, so the ROW is centred rather than its top edge) = 393.
      expect(frameEl.scrollTop).toBe(393);
    });
  });

  it('clamps to the maximum scroll rather than overshooting past the last row', () => {
    withFrameLayout(() => {
      const frameEl = renderFrame(TOTAL_LINES - 1);
      expect(frameEl.scrollTop).toBe(SCROLL_HEIGHT - CLIENT_HEIGHT);
    });
  });

  it('clamps to 0 rather than a negative scroll for a row near the top', () => {
    withFrameLayout(() => {
      const frameEl = renderFrame(0);
      expect(frameEl.scrollTop).toBe(0);
    });
  });
});
