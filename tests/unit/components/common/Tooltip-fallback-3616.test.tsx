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
  TOOLTIP_GAP,
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

describe('[#3616] Tooltip fallbackPlacement prop', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function stubRects(trigger: typeof ROW_MID): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const source = this.getAttribute('role') === 'tooltip' ? { top: 0, left: 0, ...BUBBLE } : trigger;
      return {
        ...source,
        right: source.left + source.width,
        bottom: source.top + source.height,
        x: source.left,
        y: source.top,
        toJSON: () => ({}),
      } as DOMRect;
    });
    vi.spyOn(window, 'innerWidth', 'get').mockReturnValue(VIEWPORT.width);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(VIEWPORT.height);
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
});
