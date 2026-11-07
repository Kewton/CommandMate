/**
 * WorktreeDesktopLayout — activity pane side (Issue #4219).
 *
 * Left / right x pinned / unpinned: CSS order, overlay classes, the pane node
 * is never rebuilt, the resizer sign, the move button, and the persisted side.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, renderHook, act } from '@testing-library/react';
import { WorktreeDesktopLayout } from '@/components/worktree/WorktreeDesktopLayout';
import {
  ACTIVITY_PANE_SIDE_STORAGE_KEY,
  usePaneSide,
  type PaneSide,
} from '@/hooks/usePaneSide';

const frame = {
  title: 'Files',
  testIdPrefix: 'activity-pane',
  onTogglePinned: () => {},
  onClose: () => {},
  onDismiss: () => {},
};

function layout(opts: {
  side?: PaneSide;
  pinned: boolean;
  width?: number;
  onResize?: (n: number) => void;
  onToggleSide?: () => void;
}) {
  return (
    <WorktreeDesktopLayout
      activityPane={<input data-testid="pane-field" defaultValue="" />}
      rightPane={<div data-testid="body" />}
      activityPanePinned={opts.pinned}
      activityPaneSide={opts.side}
      onToggleActivityPaneSide={opts.onToggleSide}
      activityPaneWidth={opts.width ?? 20}
      onActivityPaneResize={opts.onResize}
      activityPaneFrame={frame}
    />
  );
}

beforeEach(() => window.localStorage.clear());
afterEach(() => vi.restoreAllMocks());

describe.each([
  { side: 'right' as const, reversed: false },
  { side: 'left' as const, reversed: true },
])('pinned, side=$side', ({ side, reversed }) => {
  it('keeps DOM order body / resizer / pane and reverses the row only on the left', () => {
    render(layout({ side, pinned: true }));
    const order = Array.from(screen.getByTestId('desktop-layout').children).map(
      (el) => el.getAttribute('data-testid') ?? el.getAttribute('role')
    );
    expect(order).toEqual(['right-pane-slot', 'separator', 'activity-pane-slot']);
    const cls = screen.getByTestId('desktop-layout').className;
    expect(/\bflex-row-reverse\b/.test(cls)).toBe(reversed);
    expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-side', side);
  });
});

describe.each([
  { side: 'right' as const, on: /\bright-0\b.*\bborder-l\b/, off: /\bleft-0\b|\bborder-r\b/ },
  { side: 'left' as const, on: /\bleft-0\b.*\bborder-r\b/, off: /\bright-0\b|\bborder-l\b/ },
])('unpinned, side=$side', ({ side, on, off }) => {
  it('hangs from its own edge and has no resizer', () => {
    render(layout({ side, pinned: false }));
    const cls = screen.getByTestId('activity-pane-slot').className;
    expect(cls).toMatch(/\babsolute\b/);
    expect(cls).toMatch(on);
    expect(cls).not.toMatch(off);
    expect(screen.queryByRole('separator')).toBeNull();
  });
});

describe('the pane is never rebuilt', () => {
  it('keeps the same nodes and the typed draft across side and pin changes', () => {
    const { rerender } = render(layout({ side: 'right', pinned: false }));
    const slot = screen.getByTestId('activity-pane-slot');
    const field = screen.getByTestId('pane-field') as HTMLInputElement;
    fireEvent.change(field, { target: { value: 'draft' } });
    for (const [side, pinned] of [
      ['left', false],
      ['left', true],
      ['right', true],
      ['right', false],
    ] as const) {
      rerender(layout({ side, pinned }));
      expect(screen.getByTestId('activity-pane-slot')).toBe(slot);
      expect(screen.getByTestId('pane-field')).toBe(field);
      expect(field.value).toBe('draft');
    }
  });
});

describe('resizer sign', () => {
  function stubWidth() {
    vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(1000);
  }
  it('right: dragging right narrows, left widens', () => {
    stubWidth();
    const onResize = vi.fn();
    render(layout({ side: 'right', pinned: true, onResize }));
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(19);
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(21);
  });
  it('left: dragging left narrows, right widens', () => {
    stubWidth();
    const onResize = vi.fn();
    render(layout({ side: 'left', pinned: true, onResize }));
    const sep = screen.getByRole('separator');
    fireEvent.keyDown(sep, { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(19);
    fireEvent.keyDown(sep, { key: 'ArrowRight' });
    expect(onResize).toHaveBeenLastCalledWith(21);
  });
  it('left: min and max still clamp', () => {
    stubWidth();
    const onResize = vi.fn();
    render(layout({ side: 'left', pinned: true, width: 10, onResize }));
    fireEvent.keyDown(screen.getByRole('separator'), { key: 'ArrowLeft' });
    expect(onResize).toHaveBeenLastCalledWith(10);
  });
});

describe('move button and persistence', () => {
  it('defaults to right with a "move left" button; click moves, click again returns', () => {
    render(layout({ pinned: false }));
    const slot = screen.getByTestId('activity-pane-slot');
    expect(slot).toHaveAttribute('data-side', 'right');
    fireEvent.click(screen.getByTestId('activity-pane-side'));
    expect(slot).toHaveAttribute('data-side', 'left');
    expect(window.localStorage.getItem(ACTIVITY_PANE_SIDE_STORAGE_KEY)).toBe('left');
    expect(screen.getByTestId('activity-pane-side')).toHaveAttribute(
      'aria-label',
      'worktree.desktopLayout.movePaneRight'
    );
    fireEvent.click(screen.getByTestId('activity-pane-side'));
    expect(slot).toHaveAttribute('data-side', 'right');
  });

  it('reads a stored left on mount', () => {
    window.localStorage.setItem(ACTIVITY_PANE_SIDE_STORAGE_KEY, 'left');
    render(layout({ pinned: false }));
    expect(screen.getByTestId('activity-pane-slot')).toHaveAttribute('data-side', 'left');
  });

  it('calls the parent toggle when controlled', () => {
    const onToggleSide = vi.fn();
    render(layout({ side: 'left', pinned: false, onToggleSide }));
    fireEvent.click(screen.getByTestId('activity-pane-side'));
    expect(onToggleSide).toHaveBeenCalledTimes(1);
  });
});

describe('usePaneSide without localStorage', () => {
  it('stays right and does not throw', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { result } = renderHook(() => usePaneSide());
    expect(result.current.side).toBe('right');
    act(() => result.current.toggleSide());
    expect(result.current.side).toBe('left');
  });
  it('treats junk as right', () => {
    window.localStorage.setItem(ACTIVITY_PANE_SIDE_STORAGE_KEY, 'middle');
    const { result } = renderHook(() => usePaneSide());
    expect(result.current.side).toBe('right');
  });
});
