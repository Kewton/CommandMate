/**
 * Tests for PullToRefresh (Issue #1128)
 *
 * Verifies the pull-to-refresh gesture only fires when the container is at the
 * very top and that `onRefresh` is invoked when a pull passes the threshold.
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';

import { PullToRefresh } from '@/components/common/PullToRefresh';

/** Minimal touch event (jsdom lacks Touch/TouchEvent constructors). */
function createTouchEvent(type: string, clientY: number, target: EventTarget): TouchEvent {
  const touch = { clientX: 0, clientY, identifier: 0, target } as unknown as Touch;
  const event = new Event(type, { bubbles: true, cancelable: true }) as unknown as TouchEvent;
  Object.defineProperty(event, 'touches', { value: [touch] });
  Object.defineProperty(event, 'changedTouches', { value: [touch] });
  Object.defineProperty(event, 'target', { value: target });
  return event;
}

function setScrollTop(el: HTMLElement, value: number) {
  Object.defineProperty(el, 'scrollTop', { value, configurable: true });
}

function pull(container: HTMLElement, distance: number) {
  act(() => {
    container.dispatchEvent(createTouchEvent('touchstart', 0, container));
  });
  act(() => {
    container.dispatchEvent(createTouchEvent('touchmove', distance, container));
  });
  act(() => {
    container.dispatchEvent(createTouchEvent('touchend', distance, container));
  });
}

describe('PullToRefresh', () => {
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('renders its children inside a scroll container', () => {
    render(
      <PullToRefresh onRefresh={vi.fn()}>
        <div data-testid="child">content</div>
      </PullToRefresh>
    );
    expect(screen.getByTestId('pull-to-refresh')).toBeInTheDocument();
    expect(screen.getByTestId('child')).toBeInTheDocument();
  });

  it('calls onRefresh when pulled past the threshold at the top', async () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>
    );

    const container = screen.getByTestId('pull-to-refresh');
    setScrollTop(container, 0);

    // Raw 200px * 0.5 resistance = 100px (capped at 96) — comfortably past the
    // 64px threshold.
    pull(container, 200);

    await waitFor(() => {
      expect(onRefresh).toHaveBeenCalledTimes(1);
    });
  });

  it('does NOT call onRefresh when the container is not scrolled to the top', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>
    );

    const container = screen.getByTestId('pull-to-refresh');
    setScrollTop(container, 120);

    pull(container, 200);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does NOT call onRefresh for a small pull below the threshold', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <PullToRefresh onRefresh={onRefresh}>
        <div>content</div>
      </PullToRefresh>
    );

    const container = screen.getByTestId('pull-to-refresh');
    setScrollTop(container, 0);

    // 40px * 0.5 = 20px, well under the 64px threshold.
    pull(container, 40);

    expect(onRefresh).not.toHaveBeenCalled();
  });

  it('does NOT call onRefresh when disabled', () => {
    const onRefresh = vi.fn().mockResolvedValue(undefined);
    render(
      <PullToRefresh onRefresh={onRefresh} enabled={false}>
        <div>content</div>
      </PullToRefresh>
    );

    const container = screen.getByTestId('pull-to-refresh');
    setScrollTop(container, 0);

    pull(container, 200);

    expect(onRefresh).not.toHaveBeenCalled();
  });
});
