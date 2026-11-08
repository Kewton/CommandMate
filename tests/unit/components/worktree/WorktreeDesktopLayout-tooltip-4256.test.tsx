/**
 * Issue #4256: the pane header's tooltips follow a button that moves (side flip)
 * and stay inside the viewport when the label gets longer (pin toggle).
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { PaneOverlayFrame } from '@/components/worktree/WorktreeDesktopLayout';
import type { PaneSide } from '@/hooks/usePaneSide';

const VIEWPORT_W = 1440;
/** Fake text width: 7px per character, plus the bubble's padding. */
const textWidth = (s: string): number => s.length * 7 + 16;

let triggerRects: Map<string, DOMRect>;

function rect(left: number, width = 28): DOMRect {
  return { left, top: 40, width, height: 28, right: left + width, bottom: 68, x: left, y: 40, toJSON: () => ({}) } as DOMRect;
}

beforeEach(() => {
  triggerRects = new Map();
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_W });
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 900 });
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.getAttribute('role') === 'tooltip') {
      return { ...rect(0, textWidth(this.textContent ?? '')), height: 24 } as DOMRect;
    }
    const id = this.querySelector('[data-testid]')?.getAttribute('data-testid') ?? '';
    return triggerRects.get(id) ?? rect(0);
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function frame(side: PaneSide, pinned: boolean) {
  return (
    <PaneOverlayFrame
      title="Files"
      pinned={pinned}
      side={side}
      onTogglePinned={() => {}}
      onToggleSide={() => {}}
      onClose={() => {}}
      onDismiss={() => {}}
    >
      <div />
    </PaneOverlayFrame>
  );
}

const bubble = (): HTMLElement => document.querySelector('[role="tooltip"][data-placement]') as HTMLElement;
const leftOf = (el: HTMLElement): number => parseFloat(el.style.left);

describe('[#4256] tooltip follows state changes', () => {
  it('re-places the open tooltip when the side button moves to the other side', () => {
    triggerRects.set('pane-overlay-side', rect(1376));
    const { rerender } = render(frame('right', false));
    fireEvent.focus(screen.getByTestId('pane-overlay-side'));
    const before = leftOf(bubble());
    expect(before).toBeGreaterThan(1000);

    triggerRects.set('pane-overlay-side', rect(339));
    rerender(frame('left', false));
    const after = leftOf(bubble());
    expect(after).toBeLessThan(400);
    expect(after).toBeGreaterThanOrEqual(4);
  });

  it.each([
    { side: 'right' as const, x: 1380 },
    { side: 'left' as const, x: 4 },
  ])('keeps the pin tooltip inside the viewport when its label grows ($side)', ({ side, x }) => {
    triggerRects.set('pane-overlay-pin', rect(x));
    const { rerender } = render(frame(side, false));
    fireEvent.focus(screen.getByTestId('pane-overlay-pin'));
    rerender(frame(side, true));
    const el = bubble();
    const left = leftOf(el);
    expect(left).toBeGreaterThanOrEqual(4);
    expect(left + textWidth(el.textContent ?? '')).toBeLessThanOrEqual(VIEWPORT_W - 4);
  });

  it('does not touch anything when nothing changes or no tooltip is open (negative control)', () => {
    triggerRects.set('pane-overlay-side', rect(1376));
    const spy = vi.spyOn(window, 'dispatchEvent');
    const { rerender } = render(frame('right', false));
    rerender(frame('left', true));
    expect(spy.mock.calls.filter(([e]) => e.type === 'resize')).toHaveLength(0);
    fireEvent.focus(screen.getByTestId('pane-overlay-side'));
    const before = leftOf(bubble());
    rerender(frame('left', true));
    expect(leftOf(bubble())).toBe(before);
  });
});
