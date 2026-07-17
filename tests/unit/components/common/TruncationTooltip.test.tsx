/**
 * Tests for TruncationTooltip component (Issue #859)
 *
 * A Portal-based, hover-delayed tooltip that replaces the native `title`
 * attribute on truncated file names in the file tree. Key behaviors:
 *   - Shows only when the trigger text is actually truncated
 *     (`scrollWidth > clientWidth`).
 *   - Honors a configurable delay (default ~200ms) so fast cursor moves
 *     don't flash a tooltip.
 *   - Renders via React portal to `document.body` so it escapes the file
 *     tree's `overflow` clipping.
 *   - Tooltip element is `aria-hidden` so screen readers don't read the
 *     name twice (the visible text node is already announced).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import {
  TruncationTooltip,
  TRUNCATION_TOOLTIP_DELAY_MS,
} from '@/components/common/TruncationTooltip';

/**
 * jsdom reports 0 for scrollWidth/clientWidth and zeros for
 * getBoundingClientRect. Override them so we can simulate truncated and
 * non-truncated states deterministically.
 */
function setTruncation(el: HTMLElement, truncated: boolean): void {
  Object.defineProperty(el, 'scrollWidth', {
    configurable: true,
    value: truncated ? 200 : 50,
  });
  Object.defineProperty(el, 'clientWidth', {
    configurable: true,
    value: 100,
  });
  el.getBoundingClientRect = () =>
    ({ top: 10, bottom: 30, left: 20, right: 120, width: 100, height: 20, x: 20, y: 10, toJSON: () => ({}) }) as DOMRect;
}

describe('TruncationTooltip (Issue #859)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('exports a default delay of ~200ms', () => {
    expect(TRUNCATION_TOOLTIP_DELAY_MS).toBe(200);
  });

  it('renders children and applies the className to the trigger', () => {
    render(
      <TruncationTooltip content="package.json" className="flex-1 truncate">
        package.json
      </TruncationTooltip>
    );
    const trigger = screen.getByText('package.json');
    expect(trigger).toHaveClass('truncate');
  });

  it('does NOT set a native title attribute (delay is JS-controlled)', () => {
    render(
      <TruncationTooltip content="package.json" className="truncate">
        package.json
      </TruncationTooltip>
    );
    expect(screen.getByText('package.json')).not.toHaveAttribute('title');
  });

  it('shows the tooltip after the delay when the text is truncated', () => {
    render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toBeInTheDocument();
    expect(tooltip).toHaveTextContent('a-very-long-file-name.tsx');
  });

  it('does NOT show a tooltip when the text is not truncated', () => {
    render(
      <TruncationTooltip content="short.ts" className="truncate">
        short.ts
      </TruncationTooltip>
    );
    const trigger = screen.getByText('short.ts');
    setTruncation(trigger, false);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS + 50);
    });

    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('does not show the tooltip if the cursor leaves before the delay elapses', () => {
    render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS - 20);
    });
    fireEvent.mouseLeave(trigger);
    act(() => {
      vi.advanceTimersByTime(100);
    });

    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('hides the tooltip on mouse leave after it became visible', () => {
    render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();

    fireEvent.mouseLeave(trigger);
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('renders the tooltip into document.body via a portal (escapes clipping)', () => {
    const { container } = render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    // Portal target is document.body, not the component's own subtree.
    expect(container.contains(tooltip)).toBe(false);
    expect(document.body.contains(tooltip)).toBe(true);
    // fixed positioning so it is not clipped by scroll containers.
    expect(tooltip.className).toMatch(/fixed/);
  });

  it('marks the tooltip aria-hidden so screen readers do not read the name twice', () => {
    render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveAttribute('aria-hidden', 'true');
    // The trigger must not gain an aria-describedby pointing at the tooltip.
    expect(trigger).not.toHaveAttribute('aria-describedby');
  });

  it('respects a custom delay prop', () => {
    render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate" delay={500}>
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(screen.getByRole('tooltip', { hidden: true })).toBeInTheDocument();
  });

  // [Issue #975] Metadata is folded into the same bubble as the name so a
  // single styled tooltip replaces the old native `title` + name tooltip pair.
  it('shows the tooltip with name + metadata even when the text is NOT truncated', () => {
    render(
      <TruncationTooltip
        content="app.ts"
        metadata={'Size: 2.0 KB\nModified: yesterday'}
        className="truncate"
      >
        app.ts
      </TruncationTooltip>
    );
    const trigger = screen.getByText('app.ts');
    setTruncation(trigger, false);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toBeInTheDocument();
    // One bubble carries both the name and the formatted metadata lines.
    expect(tooltip).toHaveTextContent('app.ts');
    expect(tooltip).toHaveTextContent('Size: 2.0 KB');
    expect(tooltip).toHaveTextContent('Modified: yesterday');
  });

  it('still shows name + metadata together when the name IS truncated', () => {
    render(
      <TruncationTooltip
        content="a-very-long-file-name.tsx"
        metadata={'Size: 3.5 MB'}
        className="truncate"
      >
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });

    const tooltip = screen.getByRole('tooltip', { hidden: true });
    expect(tooltip).toHaveTextContent('a-very-long-file-name.tsx');
    expect(tooltip).toHaveTextContent('Size: 3.5 MB');
  });

  it('does NOT show a tooltip when there is no metadata and the text is not truncated', () => {
    render(
      <TruncationTooltip content="short.ts" className="truncate">
        short.ts
      </TruncationTooltip>
    );
    const trigger = screen.getByText('short.ts');
    setTruncation(trigger, false);

    fireEvent.mouseEnter(trigger);
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS + 50);
    });

    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });

  it('clears the scheduled timer on unmount (no tooltip flash after unmount)', () => {
    const { unmount } = render(
      <TruncationTooltip content="a-very-long-file-name.tsx" className="truncate">
        a-very-long-file-name.tsx
      </TruncationTooltip>
    );
    const trigger = screen.getByText('a-very-long-file-name.tsx');
    setTruncation(trigger, true);

    fireEvent.mouseEnter(trigger);
    unmount();
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS + 50);
    });

    expect(screen.queryByRole('tooltip', { hidden: true })).not.toBeInTheDocument();
  });
});

/**
 * [Issue #1365] The bubble is placed below the trigger at show time, but its
 * height is only known once it has been rendered. A second measuring pass flips
 * it above the trigger when it would otherwise spill past the bottom of the
 * viewport (a file row near the foot of the tree, especially with metadata
 * lines). The pre-existing horizontal clamp must keep working untouched.
 */
describe('TruncationTooltip vertical clamping (Issue #1365)', () => {
  const GAP = 4;
  const VIEWPORT_HEIGHT = 768;
  const VIEWPORT_WIDTH = 1024;

  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: VIEWPORT_HEIGHT });
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeRect(overrides: Partial<DOMRect>): DOMRect {
    return {
      top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0, x: 0, y: 0,
      ...overrides,
      toJSON: () => ({}),
    } as DOMRect;
  }

  /**
   * Marks the trigger as truncated and pins its own box. Setting an *own*
   * `getBoundingClientRect` keeps the trigger out of reach of the prototype
   * spy below, which therefore only ever answers for the portalled bubble.
   */
  function anchorAt(el: HTMLElement, rect: Partial<DOMRect>): void {
    Object.defineProperty(el, 'scrollWidth', { configurable: true, value: 200 });
    Object.defineProperty(el, 'clientWidth', { configurable: true, value: 100 });
    el.getBoundingClientRect = () => makeRect(rect);
  }

  /** Give the (not-yet-existing) bubble a measurable height. */
  function withBubbleHeight(height: number): void {
    vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue(
      makeRect({ height })
    );
  }

  function showTooltip(text: string, anchor: Partial<DOMRect>, height: number): HTMLElement {
    render(
      <TruncationTooltip content={text} className="truncate">
        {text}
      </TruncationTooltip>
    );
    anchorAt(screen.getByText(text), anchor);
    withBubbleHeight(height);
    fireEvent.mouseEnter(screen.getByText(text));
    act(() => {
      vi.advanceTimersByTime(TRUNCATION_TOOLTIP_DELAY_MS);
    });
    return screen.getByRole('tooltip', { hidden: true });
  }

  it('keeps the tooltip below the trigger when it fits there', () => {
    // Trigger near the top: 30 + 4 + 120 is far short of the 768px viewport.
    const tooltip = showTooltip('near-top.tsx', { top: 10, bottom: 30, left: 20, width: 100 }, 120);

    expect(tooltip).toHaveStyle({ top: `${30 + GAP}px` });
  });

  it('flips the tooltip above the trigger when it would spill past the bottom', () => {
    // 720 + 4 + 120 = 844 > 768, so it must flip: 700 - 4 - 120 = 576.
    const tooltip = showTooltip('near-bottom.tsx', { top: 700, bottom: 720, left: 20, width: 100 }, 120);

    expect(tooltip).toHaveStyle({ top: '576px' });
  });

  it('pins the tooltip to the bottom margin when it fits neither below nor above', () => {
    // A 720px bubble fits neither under (60+4+720 > 768) nor over (40-4-720 < 0)
    // the trigger, so it is pinned at 768 - 720 - 4 = 44 and its head stays on screen.
    const tooltip = showTooltip('huge.tsx', { top: 40, bottom: 60, left: 20, width: 100 }, 720);

    expect(tooltip).toHaveStyle({ top: '44px' });
  });

  it('leaves the existing horizontal clamp intact while flipping vertically', () => {
    // left 1000 would push a 384px-wide bubble off-screen: clamped to
    // 1024 - 384 - 4 = 636. The vertical flip must not disturb that.
    const tooltip = showTooltip('right-edge.tsx', { top: 700, bottom: 720, left: 1000, width: 100 }, 120);

    expect(tooltip).toHaveStyle({ left: '636px', top: '576px' });
  });
});
