/**
 * @vitest-environment jsdom
 *
 * Issue #3651: the second row's "…" panel stays in the body, right of the
 * sidebar. At 1024x768 with the sidebar open (body from x=224) the panel
 * (512px) is wider than the room left of "…" (right edge 436), and the
 * viewport-only clamp drew it from x=8 — over the sidebar.
 *
 * jsdom does no layout, so the rects are stubbed per element and the result is
 * read from the panel's inline `left` / `max-width`.
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import {
  ActionBarItemsOverflow,
  clampOverflowPanelLeft,
  overflowPanelMaxWidth,
} from '@/components/worktree/TerminalSplitContainer';

vi.mock('next-intl', async () => {
  const { createRealIntlMock } = await import('@tests/helpers/real-intl');
  return createRealIntlMock('en');
});

const SIDEBAR_RIGHT = 224;

type Rect = { left: number; top: number; width: number; height: number };

let rects: Record<string, Rect> = {};

function domRect({ left, top, width, height }: Rect): DOMRect {
  return {
    left,
    top,
    width,
    height,
    x: left,
    y: top,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect;
}

beforeEach(() => {
  vi.stubGlobal('innerWidth', 1024);
  rects = {
    'terminal-split-container': { left: SIDEBAR_RIGHT, top: 44, width: 800, height: 724 },
    // "…" ends 436px from the left, as in the UAT capture.
    'split-action-bar-items-overflow': { left: 408, top: 48, width: 28, height: 28 },
    'split-action-bar-items-panel': { left: 0, top: 0, width: 512, height: 44 },
  };
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const rect = rects[this.getAttribute('data-testid') ?? ''];
    return domRect(rect ?? { left: 0, top: 0, width: 0, height: 0 });
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

function openPanel(inBody: boolean): HTMLElement {
  const overflow = (
    <ActionBarItemsOverflow label="More">
      <button type="button">chip</button>
    </ActionBarItemsOverflow>
  );
  render(inBody ? <div data-testid="terminal-split-container">{overflow}</div> : overflow);
  fireEvent.click(screen.getByTestId('split-action-bar-items-overflow'));
  return screen.getByTestId('split-action-bar-items-panel');
}

describe('"…" panel stays right of the sidebar (Issue #3651)', () => {
  it('starts right of the body\'s left edge at 1024px with the sidebar open', () => {
    const panel = openPanel(true);
    const left = parseFloat(panel.style.left);
    expect(left).toBeGreaterThan(SIDEBAR_RIGHT);
    expect(left).toBe(SIDEBAR_RIGHT + 8);
    // Its right edge still inside the viewport, and its cap measured from the body.
    expect(left + 512).toBeLessThanOrEqual(1024 - 8);
    expect(panel.style.maxWidth).toBe(`${1024 - SIDEBAR_RIGHT - 16}px`);
  });

  it('stays right-aligned with "…" when there is room (negative control)', () => {
    rects['split-action-bar-items-overflow'] = { left: 872, top: 48, width: 28, height: 28 };
    const panel = openPanel(true);
    expect(panel.style.left).toBe(`${900 - 512}px`);
  });

  it('keeps the viewport margin without a body container (the former behaviour)', () => {
    const panel = openPanel(false);
    expect(panel.style.left).toBe('8px');
    expect(panel.style.maxWidth).toBe(`${1024 - 16}px`);
  });
});

describe('clampOverflowPanelLeft region (Issue #3651)', () => {
  it('pins the left edge to the region, not the viewport, when "…" leaves too little room', () => {
    expect(clampOverflowPanelLeft(436, 512, 1024, SIDEBAR_RIGHT)).toBe(232);
  });

  it('pins a panel too wide for the region to its left margin', () => {
    expect(clampOverflowPanelLeft(436, 900, 1024, SIDEBAR_RIGHT)).toBe(232);
  });

  it('is unchanged without a region (negative control)', () => {
    expect(clampOverflowPanelLeft(436, 512, 1024)).toBe(8);
    expect(clampOverflowPanelLeft(900, 300, 1440, SIDEBAR_RIGHT)).toBe(600);
  });

  it('caps the width from the region to the viewport', () => {
    expect(overflowPanelMaxWidth(1024, SIDEBAR_RIGHT)).toBe(784);
    expect(overflowPanelMaxWidth(1440)).toBe(1424);
  });
});
