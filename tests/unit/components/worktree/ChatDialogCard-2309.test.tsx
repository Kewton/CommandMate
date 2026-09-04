/**
 * `ChatDialogCard`'s Issue #2309 additions: a selection list is not tail-sliced,
 * the PC box grows so that is real scrollable space, and the arrow-moved
 * highlight is kept in view inside that scroll.
 *
 * `ChatSurface-dialog-card-2254.test.tsx` covers the wiring (the surface picks
 * the taller `max-h-*` class, the frame it hands the card is the right one).
 * This file is `ChatDialogCard` in isolation: the pure highlight finder, and
 * that the frame element's `scrollTop` actually moves when the DOM reports a
 * real, scrollable layout (jsdom reports `scrollHeight`/`clientHeight` as `0`
 * by default, which is why every assertion below stubs them first).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import { ChatDialogCard, findHighlightLineIndex } from '@/components/worktree/ChatDialogCard';

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// findHighlightLineIndex — pure
// ---------------------------------------------------------------------------

describe('[#2309] findHighlightLineIndex', () => {
  it('finds claude/copilot’s ❯ caret', () => {
    expect(findHighlightLineIndex('Select model\n  1. Default\n❯ 2. Opus\n  3. Fable')).toBe(2);
  });

  it('finds codex’s › caret', () => {
    expect(findHighlightLineIndex('Select Model and Effort\n  1. GPT\n› 2. Fast\n  3. Slow')).toBe(2);
  });

  it('finds gemini’s ● caret', () => {
    expect(findHighlightLineIndex('Pick one\n  Option A\n● Option B\n  Option C')).toBe(2);
  });

  it('returns -1 when nothing is highlighted', () => {
    expect(findHighlightLineIndex('Select model\n  1. Default\n  2. Opus\n  3. Fable')).toBe(-1);
  });

  it('returns the LAST caret when more than one line has one', () => {
    // A redraw between polls could momentarily leave a stale caret above the
    // current one; the row nearest the footer is the one that matters.
    expect(findHighlightLineIndex('❯ Item 1\n  Item 2\n❯ Item 3')).toBe(2);
  });

  it('requires a leading position, not a caret mid-sentence in a reply', () => {
    expect(findHighlightLineIndex('The current pick is Opus ❯ Fable, choose one')).toBe(-1);
  });

  it('requires a label after the caret, not the glyph alone', () => {
    expect(findHighlightLineIndex('❯')).toBe(-1);
  });

  it('tolerates leading whitespace before the caret', () => {
    expect(findHighlightLineIndex('Select model\n   ❯ 2. Opus')).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The rendered card — selection-list tail behaviour and highlight follow
// ---------------------------------------------------------------------------

const SELECTION_LIST_FRAME = [
  'a-line-far-above-the-tail-window',
  ...Array.from({ length: 30 }, (_v, i) => `model row ${i}`),
  '❯ the highlighted model',
  'type to search · ↑/↓ navigate · enter to select · esc to cancel',
].join('\n');

/**
 * jsdom never lays anything out — every element reports `scrollHeight` /
 * `clientHeight` `0` — so the follow effect's own guard (`scrollable <= 0`)
 * always short-circuits it unless the metrics are patched onto the prototype
 * BEFORE the component mounts, so the very first `useLayoutEffect` run already
 * sees a scrollable box. Restored in a `finally` so one test's patch cannot
 * leak into the next.
 */
function withScrollMetrics(
  scrollHeight: number,
  clientHeight: number,
  run: () => void,
): void {
  const proto = HTMLElement.prototype;
  const original = {
    scrollHeight: Object.getOwnPropertyDescriptor(proto, 'scrollHeight'),
    clientHeight: Object.getOwnPropertyDescriptor(proto, 'clientHeight'),
  };
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, value: scrollHeight });
  Object.defineProperty(proto, 'clientHeight', { configurable: true, value: clientHeight });
  try {
    run();
  } finally {
    if (original.scrollHeight) Object.defineProperty(proto, 'scrollHeight', original.scrollHeight);
    if (original.clientHeight) Object.defineProperty(proto, 'clientHeight', original.clientHeight);
  }
}

describe('[#2309] a selection-list card is not tail-sliced', () => {
  it('keeps content a tail slice would have dropped', () => {
    render(<ChatDialogCard frame={SELECTION_LIST_FRAME} reason="selectionList" />);
    const frameEl = screen.getByTestId('chat-dialog-card-frame');
    expect(frameEl).toHaveTextContent('a-line-far-above-the-tail-window');
    expect(frameEl).toHaveTextContent('esc to cancel');
  });

  it('still tail-slices a non-selection-list reason', () => {
    render(<ChatDialogCard frame={SELECTION_LIST_FRAME} reason="pager" />);
    const frameEl = screen.getByTestId('chat-dialog-card-frame');
    expect(frameEl).not.toHaveTextContent('a-line-far-above-the-tail-window');
    expect(frameEl).toHaveTextContent('esc to cancel');
  });
});

describe('[#2309] the highlighted row is kept in view', () => {
  it('scrolls toward the highlight when the frame is taller than the box', () => {
    withScrollMetrics(1000, 100, () => {
      render(<ChatDialogCard frame={SELECTION_LIST_FRAME} reason="selectionList" />);
      const frameEl = screen.getByTestId('chat-dialog-card-frame') as HTMLDivElement;
      expect(frameEl.scrollTop).toBeGreaterThan(0);
    });
  });

  it('does not move the scroll position when nothing is highlighted', () => {
    const noHighlight = SELECTION_LIST_FRAME.replace('❯ the highlighted model', '  the current model');
    withScrollMetrics(1000, 100, () => {
      render(<ChatDialogCard frame={noHighlight} reason="selectionList" />);
      const frameEl = screen.getByTestId('chat-dialog-card-frame') as HTMLDivElement;
      expect(frameEl.scrollTop).toBe(0);
    });
  });

  it('leaves a non-selection-list card alone even with a caret-shaped line in it', () => {
    // Arrow navigation belongs to selectionList only — a pager's tail could
    // coincidentally start a line with one of the caret glyphs, and that must
    // not turn into a scroll no answer key on the pager card can explain.
    const pagerFrame = SELECTION_LIST_FRAME.replace('model row 5', '❯ model row 5');
    withScrollMetrics(1000, 100, () => {
      render(<ChatDialogCard frame={pagerFrame} reason="pager" />);
      const frameEl = screen.getByTestId('chat-dialog-card-frame') as HTMLDivElement;
      expect(frameEl.scrollTop).toBe(0);
    });
  });

  it('never throws when the box cannot scroll at all (content fits whole)', () => {
    expect(() => {
      render(<ChatDialogCard frame={SELECTION_LIST_FRAME} reason="selectionList" />);
    }).not.toThrow();
  });
});
