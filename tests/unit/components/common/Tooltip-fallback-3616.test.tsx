/**
 * Issue #3616: a tooltip can name a fallback placement. A `right` bubble that
 * would cross the viewport's right edge flips to the `left` instead of being
 * clamped back over its trigger (in the header's session list, over the
 * other rows). Tooltips that name no fallback are placed exactly as before.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import {
  Tooltip,
  computeTooltipPosition,
  resolveTooltipWrap,
  TOOLTIP_GAP,
  TOOLTIP_MIN_WRAP_WIDTH,
  TOOLTIP_VIEWPORT_MARGIN,
  type TooltipPlacement,
} from '@/components/common/Tooltip';

const VIEWPORT = { width: 1280, height: 800 };
const BUBBLE = { width: 120, height: 24 };
/** A list row hard against the right edge: no room for a 120px bubble on its right. */
const ROW_AT_RIGHT_EDGE = { top: 100, left: 990, width: 280, height: 32 };
/** The same row mid-screen: room on both sides. */
const ROW_MID = { top: 100, left: 400, width: 280, height: 32 };

describe('[#3616] computeTooltipPosition fallback', () => {
  it('flips "right" to "left" when the right side has no room', () => {
    const { left, top } = computeTooltipPosition('right', ROW_AT_RIGHT_EDGE, BUBBLE, VIEWPORT, 'left');
    expect(left).toBe(ROW_AT_RIGHT_EDGE.left - BUBBLE.width - TOOLTIP_GAP);
    // Beside the row: vertically centred on it, so it covers no other row.
    expect(top).toBe(ROW_AT_RIGHT_EDGE.top + ROW_AT_RIGHT_EDGE.height / 2 - BUBBLE.height / 2);
    expect(left + BUBBLE.width).toBeLessThanOrEqual(ROW_AT_RIGHT_EDGE.left);
  });

  it('keeps "right" when it fits, even with a fallback', () => {
    const { left } = computeTooltipPosition('right', ROW_MID, BUBBLE, VIEWPORT, 'left');
    expect(left).toBe(ROW_MID.left + ROW_MID.width + TOOLTIP_GAP);
  });

  it('keeps the primary (clamped) when the fallback does not fit either', () => {
    const fullWidth = { top: 100, left: 2, width: 1276, height: 32 };
    const { left } = computeTooltipPosition('right', fullWidth, BUBBLE, VIEWPORT, 'left');
    expect(left).toBe(VIEWPORT.width - BUBBLE.width - TOOLTIP_VIEWPORT_MARGIN);
  });

  it('negative control: without a fallback, an overflowing "right" is clamped as before', () => {
    const { left } = computeTooltipPosition('right', ROW_AT_RIGHT_EDGE, BUBBLE, VIEWPORT);
    expect(left).toBe(VIEWPORT.width - BUBBLE.width - TOOLTIP_VIEWPORT_MARGIN);
  });

  it('negative control: every placement without a fallback is unchanged', () => {
    const placements: TooltipPlacement[] = ['top', 'right', 'bottom', 'left'];
    for (const p of placements) {
      expect(computeTooltipPosition(p, ROW_AT_RIGHT_EDGE, BUBBLE, VIEWPORT, undefined)).toEqual(
        computeTooltipPosition(p, ROW_AT_RIGHT_EDGE, BUBBLE, VIEWPORT),
      );
    }
  });
});

/** A long label: wider than the room on either side of the rows below. */
const LONG_BUBBLE = { width: 600, height: 24 };
/** A narrow screen (1024 with the sidebar open): the list's rows sit mid-right. */
const NARROW = { width: 1024, height: 360 };
/** The list's last row, only partly visible at the bottom of a short screen. */
const PARTIAL_ROW = { top: 348, left: 500, width: 280, height: 32 };

describe('[#3616] resolveTooltipWrap (neither side fits)', () => {
  it('wraps the bubble to the roomier side, narrowed to that room', () => {
    // left room: 500 − 8 − 4 = 488; right room: 1024 − 4 − (780 + 8) = 232.
    expect(resolveTooltipWrap('right', PARTIAL_ROW, LONG_BUBBLE, NARROW, 'left')).toEqual({
      placement: 'left',
      maxWidth: 488,
    });
  });

  it('the wrapped bubble is placed beside the row and covers no row above or below it', () => {
    const wrap = resolveTooltipWrap('right', PARTIAL_ROW, LONG_BUBBLE, NARROW, 'left')!;
    // Wrapped to 488px it takes three lines.
    const wrapped = { width: wrap.maxWidth, height: 64 };
    const { left, top } = computeTooltipPosition(wrap.placement, PARTIAL_ROW, wrapped, NARROW);
    // Entirely left of the row's column, so no other row of the list is under it…
    expect(left + wrapped.width).toBeLessThanOrEqual(PARTIAL_ROW.left - TOOLTIP_GAP);
    expect(left).toBeGreaterThanOrEqual(TOOLTIP_VIEWPORT_MARGIN);
    // …even though the vertical clamp moved it up above the partly visible row.
    expect(top + wrapped.height).toBeLessThanOrEqual(NARROW.height - TOOLTIP_VIEWPORT_MARGIN);
  });

  it('positive control: without the wrap, the old clamp puts it back over the row column', () => {
    const { left } = computeTooltipPosition('right', PARTIAL_ROW, LONG_BUBBLE, NARROW, 'left');
    expect(left).toBeLessThan(PARTIAL_ROW.left + PARTIAL_ROW.width);
  });

  it('is null when one side fits, without a fallback, or for a vertical pair', () => {
    expect(resolveTooltipWrap('right', ROW_MID, BUBBLE, VIEWPORT, 'left')).toBeNull();
    expect(resolveTooltipWrap('right', ROW_AT_RIGHT_EDGE, BUBBLE, VIEWPORT, 'left')).toBeNull();
    expect(resolveTooltipWrap('right', PARTIAL_ROW, LONG_BUBBLE, NARROW)).toBeNull();
    expect(resolveTooltipWrap('bottom', PARTIAL_ROW, LONG_BUBBLE, NARROW, 'top')).toBeNull();
  });

  it(`is null when even the roomier side is under ${TOOLTIP_MIN_WRAP_WIDTH}px (the old clamp stands)`, () => {
    const fullWidth = { top: 100, left: 40, width: 944, height: 32 };
    expect(resolveTooltipWrap('right', fullWidth, LONG_BUBBLE, NARROW, 'left')).toBeNull();
  });
});

describe('[#3616] Tooltip fallbackPlacement prop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubRects(
    trigger: typeof ROW_MID,
    bubble: typeof BUBBLE = BUBBLE,
    viewport: typeof VIEWPORT = VIEWPORT,
  ): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      // A bubble given a max width wraps: narrower, and taller by its line count.
      const max = parseFloat((this as HTMLElement).style?.maxWidth ?? '');
      const lines = Number.isFinite(max) && max < bubble.width ? Math.ceil(bubble.width / max) : 1;
      const width = lines > 1 ? max : bubble.width;
      const source =
        this.getAttribute('role') === 'tooltip'
          ? { top: 0, left: 0, width, height: bubble.height * lines }
          : trigger;
      return {
        ...source,
        right: source.left + source.width,
        bottom: source.top + source.height,
        x: source.left,
        y: source.top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(viewport.width);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(viewport.height);
  }

  function show(): HTMLElement {
    fireEvent.focus(screen.getByRole('button'));
    return screen.getByRole('tooltip', { hidden: true });
  }

  it('places the bubble on the fallback side when the primary side has no room', () => {
    stubRects(ROW_AT_RIGHT_EDGE);
    render(
      <Tooltip content="Codex: Idle" placement="right" fallbackPlacement="left">
        <button type="button">row</button>
      </Tooltip>,
    );
    expect(show().style.left).toBe(`${ROW_AT_RIGHT_EDGE.left - BUBBLE.width - TOOLTIP_GAP}px`);
  });

  it('negative control: without the prop the bubble is clamped at the right edge as before', () => {
    stubRects(ROW_AT_RIGHT_EDGE);
    render(
      <Tooltip content="Files" placement="right">
        <button type="button">Files</button>
      </Tooltip>,
    );
    expect(show().style.left).toBe(`${VIEWPORT.width - BUBBLE.width - TOOLTIP_VIEWPORT_MARGIN}px`);
  });

  it('wraps a bubble that fits on neither side and keeps it beside the row', () => {
    stubRects(PARTIAL_ROW, LONG_BUBBLE, NARROW);
    render(
      <Tooltip content="a very long label" placement="right" fallbackPlacement="left">
        <button type="button">row</button>
      </Tooltip>,
    );
    const bubble = show();
    expect(bubble.style.maxWidth).toBe('488px');
    expect(bubble.style.whiteSpace).toBe('normal');
    const left = parseFloat(bubble.style.left);
    expect(left + 488).toBeLessThanOrEqual(PARTIAL_ROW.left - TOOLTIP_GAP);
  });

  it('negative control: without the prop a too-long bubble is not wrapped, only clamped', () => {
    stubRects(PARTIAL_ROW, LONG_BUBBLE, NARROW);
    render(
      <Tooltip content="a very long label" placement="right">
        <button type="button">row</button>
      </Tooltip>,
    );
    const bubble = show();
    expect(bubble.style.maxWidth).toBe('');
    expect(bubble.style.whiteSpace).toBe('');
    expect(bubble.style.left).toBe(`${NARROW.width - LONG_BUBBLE.width - TOOLTIP_VIEWPORT_MARGIN}px`);
  });
});
