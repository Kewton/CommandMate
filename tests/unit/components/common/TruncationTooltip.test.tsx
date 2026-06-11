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
