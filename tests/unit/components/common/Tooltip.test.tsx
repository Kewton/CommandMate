/**
 * Tests for Tooltip component (Issue #730)
 *
 * Custom tooltip used by ActivityBar icons to provide hover-delayed labels
 * with dark theme styling and a11y-correct semantics.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  Tooltip,
  TOOLTIP_DELAY_MS,
  TOOLTIP_GAP,
  TOOLTIP_VIEWPORT_MARGIN,
  computeTooltipPosition,
} from '@/components/common/Tooltip';

describe('Tooltip (Issue #730)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports TOOLTIP_DELAY_MS = 100', () => {
    expect(TOOLTIP_DELAY_MS).toBe(100);
  });

  it('renders children initially without a tooltip element', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    expect(screen.getByRole('button', { name: 'Files' })).toBeInTheDocument();
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('shows tooltip after TOOLTIP_DELAY_MS on mouse enter', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
    expect(screen.getByRole('tooltip', { hidden: true })).toHaveTextContent('Files');
  });

  it('does not show tooltip when mouseLeave fires before delay', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS - 10);
    });
    fireEvent.mouseLeave(wrapper);
    act(() => {
      vi.advanceTimersByTime(50);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('hides tooltip on mouse leave after it became visible', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
    fireEvent.mouseLeave(wrapper);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('clears scheduled timer on unmount (no tooltip flash after unmount)', () => {
    const { unmount } = render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    unmount();
    // Should not throw or warn: timer cleared
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS + 50);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('records the requested placement on the bubble', () => {
    render(
      <Tooltip content="Files" placement="right">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveAttribute('data-placement', 'right');
  });

  it('applies dark theme classes', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    // Issue #1082: inverted-surface tokens (theme-following) replace raw gray.
    expect(tooltip.className).toMatch(/bg-foreground/);
    expect(tooltip.className).toMatch(/text-background/);
  });

  it('uses role="tooltip" and aria-hidden="true" (no aria-describedby usage)', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveAttribute('aria-hidden', 'true');
    // child button should not have aria-describedby auto-injected
    const button = screen.getByRole('button', { name: 'Files' });
    expect(button).not.toHaveAttribute('aria-describedby');
  });

  it('preserves child aria-label and does not modify children element', () => {
    render(
      <Tooltip content="Files">
        <button aria-label="Files activity">Icon</button>
      </Tooltip>
    );
    const btn = screen.getByRole('button', { name: 'Files activity' });
    expect(btn).toHaveAttribute('aria-label', 'Files activity');
  });

  it('wrapper span has tabIndex=-1 (not Tab-focusable)', () => {
    render(
      <Tooltip content="Files">
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    expect(wrapper.tagName).toBe('SPAN');
    expect(wrapper).toHaveAttribute('tabindex', '-1');
  });

  it('child onClick still fires (event transparency)', () => {
    const onClick = vi.fn();
    render(
      <Tooltip content="Files">
        <button onClick={onClick}>Files</button>
      </Tooltip>
    );
    fireEvent.click(screen.getByRole('button', { name: 'Files' }));
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it('respects custom delay prop', () => {
    render(
      <Tooltip content="Files" delay={300}>
        <button>Files</button>
      </Tooltip>
    );
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(100);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
  });
});

/**
 * Issue #1341 / #1364: the bubble is portaled to `document.body` and positioned
 * with clamped `position: fixed` coordinates, so it can no longer be clipped by
 * a narrow sidebar's bounds nor overflow a viewport edge.
 */
describe('computeTooltipPosition (Issue #1341, #1364)', () => {
  const VIEWPORT = { width: 1280, height: 800 };
  // A 28px square trigger button, mid-viewport, with room on every side.
  const TRIGGER = { top: 300, left: 600, width: 28, height: 28 };
  // A typical sidebar action tooltip, e.g. "Toggle view mode (grouped / flat)".
  const BUBBLE = { width: 208, height: 24 };

  it('centres a "bottom" tooltip under the trigger and gaps it below', () => {
    const { top, left } = computeTooltipPosition('bottom', TRIGGER, BUBBLE, VIEWPORT);
    expect(top).toBe(TRIGGER.top + TRIGGER.height + TOOLTIP_GAP);
    // trigger centre 614 − half the bubble (104) = 510
    expect(left).toBe(510);
  });

  it('centres a "right" tooltip vertically and gaps it to the right (ActivityBar)', () => {
    const { top, left } = computeTooltipPosition('right', TRIGGER, BUBBLE, VIEWPORT);
    expect(left).toBe(TRIGGER.left + TRIGGER.width + TOOLTIP_GAP);
    // trigger centre 314 − half the bubble (12) = 302
    expect(top).toBe(302);
  });

  it('centres a "top" tooltip above and a "left" tooltip beside the trigger', () => {
    expect(computeTooltipPosition('top', TRIGGER, BUBBLE, VIEWPORT).top).toBe(
      TRIGGER.top - BUBBLE.height - TOOLTIP_GAP
    );
    expect(computeTooltipPosition('left', TRIGGER, BUBBLE, VIEWPORT).left).toBe(
      TRIGGER.left - BUBBLE.width - TOOLTIP_GAP
    );
  });

  it('clamps a "bottom" tooltip that would overflow the left edge (min 160px sidebar)', () => {
    // Leftmost sidebar button: centring a 208px bubble under it wants left = −86.
    const trigger = { top: 40, left: 8, width: 28, height: 28 };
    const { left } = computeTooltipPosition('bottom', trigger, BUBBLE, VIEWPORT);
    expect(left).toBe(TOOLTIP_VIEWPORT_MARGIN);
    expect(left).toBeGreaterThanOrEqual(0);
  });

  it('clamps a "bottom" tooltip that would overflow the right edge', () => {
    // Trigger hard against the right edge: centring wants left = 1258.
    const trigger = { top: 40, left: 1240, width: 28, height: 28 };
    const { left } = computeTooltipPosition('bottom', trigger, BUBBLE, VIEWPORT);
    expect(left).toBe(VIEWPORT.width - BUBBLE.width - TOOLTIP_VIEWPORT_MARGIN);
    expect(left + BUBBLE.width).toBeLessThanOrEqual(VIEWPORT.width);
  });

  it('clamps vertically so a "top" tooltip near the viewport top stays visible', () => {
    const trigger = { top: 2, left: 600, width: 28, height: 28 };
    const { top } = computeTooltipPosition('top', trigger, BUBBLE, VIEWPORT);
    expect(top).toBe(TOOLTIP_VIEWPORT_MARGIN);
  });

  it('pins to the leading margin when the bubble is wider than the viewport', () => {
    const narrow = { width: 200, height: 800 };
    const wide = { width: 400, height: 24 };
    const { left } = computeTooltipPosition('bottom', TRIGGER, wide, narrow);
    // Cannot fit: pin to the leading edge rather than jump off-screen.
    expect(left).toBe(TOOLTIP_VIEWPORT_MARGIN);
  });
});

describe('Tooltip portal + clamping integration (Issue #1341, #1364)', () => {
  const TRIGGER_RECT = { top: 40, left: 8, width: 28, height: 28 };
  const BUBBLE_RECT = { width: 208, height: 24 };

  beforeEach(() => {
    vi.useFakeTimers();
    // jsdom reports every rect as zero-sized, so stub the two we measure.
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
      this: Element
    ) {
      const source =
        this.getAttribute('role') === 'tooltip'
          ? { top: 0, left: 0, ...BUBBLE_RECT }
          : TRIGGER_RECT;
      return {
        ...source,
        right: source.left + source.width,
        bottom: source.top + source.height,
        x: source.left,
        y: source.top,
        toJSON: () => ({}),
      } as DOMRect;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  function hover(): HTMLElement {
    const wrapper = screen.getByTestId('tooltip-wrapper');
    fireEvent.mouseEnter(wrapper);
    act(() => {
      vi.advanceTimersByTime(TOOLTIP_DELAY_MS);
    });
    return screen.getByRole('tooltip', { hidden: true });
  }

  it('renders the bubble under document.body, outside the wrapper subtree', () => {
    render(
      <Tooltip content="Toggle view mode (grouped / flat)" placement="bottom">
        <button>Toggle</button>
      </Tooltip>
    );
    const tooltip = hover();
    // The bubble escapes the wrapper (and any clipping ancestor)…
    expect(screen.getByTestId('tooltip-wrapper')).not.toContainElement(tooltip);
    expect(tooltip.parentElement).toBe(document.body);
    // …while the trigger stays inside the wrapper that owns the mouse events.
    expect(screen.getByTestId('tooltip-wrapper')).toContainElement(
      screen.getByRole('button', { name: 'Toggle' })
    );
    expect(tooltip.className).toMatch(/\bfixed\b/);
  });

  it('clamps a left-edge "bottom" tooltip into the viewport instead of off-screen', () => {
    render(
      <Tooltip content="Toggle view mode (grouped / flat)" placement="bottom">
        <button>Toggle</button>
      </Tooltip>
    );
    const tooltip = hover();
    // Naive centring wants left = −86px; clamping keeps it fully on screen.
    expect(tooltip.style.left).toBe(`${TOOLTIP_VIEWPORT_MARGIN}px`);
    expect(tooltip.style.top).toBe(`${TRIGGER_RECT.top + TRIGGER_RECT.height + TOOLTIP_GAP}px`);
  });

  it('removes the portaled bubble from the body on mouse leave', () => {
    render(
      <Tooltip content="Files" placement="bottom">
        <button>Files</button>
      </Tooltip>
    );
    hover();
    fireEvent.mouseLeave(screen.getByTestId('tooltip-wrapper'));
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('removes the portaled bubble when the trigger unmounts while visible', () => {
    const { unmount } = render(
      <Tooltip content="Files" placement="bottom">
        <button>Files</button>
      </Tooltip>
    );
    hover();
    unmount();
    expect(document.body.querySelector('[role="tooltip"]')).toBeNull();
  });

  it('repositions on scroll so the fixed bubble stays anchored to its trigger', () => {
    render(
      <Tooltip content="Files" placement="bottom">
        <button>Files</button>
      </Tooltip>
    );
    const tooltip = hover();
    expect(tooltip.style.top).toBe(`${TRIGGER_RECT.top + TRIGGER_RECT.height + TOOLTIP_GAP}px`);

    // The trigger scrolls up; the next measurement must follow it.
    TRIGGER_RECT.top = 140;
    act(() => {
      fireEvent.scroll(document, {});
    });
    expect(tooltip.style.top).toBe(`${140 + TRIGGER_RECT.height + TOOLTIP_GAP}px`);
    TRIGGER_RECT.top = 40;
  });
});
