/**
 * useInViewport — the verdict the tile grid gates its pollers on (Issue #2509).
 *
 * The behaviour worth pinning is the two ends of it: nothing is "visible" until
 * an observer says so, and an environment with NO observer calls everything
 * visible rather than nothing. The second half is the one that would fail
 * silently — a `false` fallback renders a wall of permanently empty tiles, which
 * looks like a data problem and not like a missing browser API.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useInViewport } from '@/hooks/useInViewport';

type IOCallback = (entries: IntersectionObserverEntry[]) => void;

let observers: Array<{ callback: IOCallback; options?: IntersectionObserverInit; nodes: Element[] }> = [];
const disconnectSpy = vi.fn();

class MockIntersectionObserver {
  private entry: { callback: IOCallback; options?: IntersectionObserverInit; nodes: Element[] };
  constructor(callback: IOCallback, options?: IntersectionObserverInit) {
    this.entry = { callback, options, nodes: [] };
    observers.push(this.entry);
  }
  observe = (node: Element) => {
    this.entry.nodes.push(node);
  };
  unobserve = vi.fn();
  disconnect = disconnectSpy;
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = '';
  thresholds = [];
}

function Probe({ rootMargin }: { rootMargin?: string }) {
  const { ref, inViewport } = useInViewport<HTMLDivElement>({ rootMargin });
  return <div ref={ref} data-testid="probe" data-in-viewport={inViewport ? 'true' : 'false'} />;
}

function verdict(): string | null {
  return screen.getByTestId('probe').getAttribute('data-in-viewport');
}

function report(isIntersecting: boolean): void {
  const observer = observers[observers.length - 1];
  act(() => {
    observer.callback(
      observer.nodes.map((target) => ({
        target,
        isIntersecting,
        intersectionRatio: isIntersecting ? 1 : 0,
        boundingClientRect: {} as DOMRectReadOnly,
        intersectionRect: {} as DOMRectReadOnly,
        rootBounds: null,
        time: 0,
      })) as IntersectionObserverEntry[],
    );
  });
}

let original: unknown;

beforeEach(() => {
  observers = [];
  disconnectSpy.mockClear();
  original = (globalThis as unknown as Record<string, unknown>).IntersectionObserver;
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
  (window as unknown as Record<string, unknown>).IntersectionObserver = MockIntersectionObserver;
});

afterEach(() => {
  (globalThis as unknown as Record<string, unknown>).IntersectionObserver = original;
  (window as unknown as Record<string, unknown>).IntersectionObserver = original;
});

describe('useInViewport (Issue #2509)', () => {
  it('starts false and observes the attached node', () => {
    render(<Probe />);

    expect(verdict()).toBe('false');
    expect(observers).toHaveLength(1);
    expect(observers[0].nodes[0]).toBe(screen.getByTestId('probe'));
  });

  it('forwards rootMargin to the observer', () => {
    render(<Probe rootMargin="512px" />);

    expect(observers[0].options?.rootMargin).toBe('512px');
  });

  it('follows the observer in both directions', () => {
    render(<Probe />);

    report(true);
    expect(verdict()).toBe('true');

    report(false);
    expect(verdict()).toBe('false');
  });

  it('disconnects on unmount', () => {
    const { unmount } = render(<Probe />);

    unmount();

    expect(disconnectSpy).toHaveBeenCalled();
  });

  it('calls everything visible when the environment has no IntersectionObserver', () => {
    (globalThis as unknown as Record<string, unknown>).IntersectionObserver = undefined;
    (window as unknown as Record<string, unknown>).IntersectionObserver = undefined;

    render(<Probe />);

    expect(verdict()).toBe('true');
    expect(observers).toHaveLength(0);
  });
});
