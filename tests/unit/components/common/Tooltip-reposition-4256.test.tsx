/**
 * Issue #4256: the shared Tooltip re-places an open bubble when its trigger
 * moves or its content changes, and keeps it inside the viewport.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Tooltip } from '@/components/common/Tooltip';

const VIEWPORT_W = 1000;
let triggerLeft = 0;
let bubbleMeasures = 0;

beforeEach(() => {
  triggerLeft = 0;
  bubbleMeasures = 0;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_W });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'tooltip') {
      bubbleMeasures += 1;
      const w = (this.textContent ?? '').length * 7 + 16;
      return { left: 0, top: 0, width: w, height: 24, right: w, bottom: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    }
    return {
      left: triggerLeft, top: 40, width: 28, height: 28,
      right: triggerLeft + 28, bottom: 68, x: triggerLeft, y: 40, toJSON: () => ({}),
    } as DOMRect;
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const ui = (content: string) => (
  <Tooltip content={content} placement="bottom">
    <button data-testid="b">x</button>
  </Tooltip>
);
const bubble = (): HTMLElement => document.querySelector('[role="tooltip"]') as HTMLElement;
const left = (): number => parseFloat(bubble().style.left);

describe('[#4256] Tooltip repositioning', () => {
  it('follows the trigger when it moves while open', () => {
    triggerLeft = 800;
    const { rerender } = render(ui('Move left'));
    fireEvent.focus(screen.getByTestId('b'));
    const before = left();
    triggerLeft = 100;
    rerender(ui('Move left'));
    expect(left()).toBeLessThan(before - 400);
  });

  it.each([
    { name: 'right edge', x: 960 },
    { name: 'left edge', x: 0 },
  ])('stays inside the viewport when the content grows ($name)', ({ x }) => {
    triggerLeft = x;
    const { rerender } = render(ui('Pin'));
    fireEvent.focus(screen.getByTestId('b'));
    const long = 'Unpin (overlay on top of the terminal)';
    rerender(ui(long));
    const w = long.length * 7 + 16;
    expect(left()).toBeGreaterThanOrEqual(4);
    expect(left() + w).toBeLessThanOrEqual(VIEWPORT_W - 4);
  });

  it('does not re-measure when nothing changed (negative control)', () => {
    triggerLeft = 300;
    const { rerender } = render(ui('Same'));
    fireEvent.focus(screen.getByTestId('b'));
    const before = left();
    bubbleMeasures = 0;
    rerender(ui('Same'));
    expect(bubbleMeasures).toBe(0);
    expect(left()).toBe(before);
  });
});
