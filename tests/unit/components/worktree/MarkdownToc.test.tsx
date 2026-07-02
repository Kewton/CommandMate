/**
 * Tests for MarkdownToc component (Issue #1007)
 *
 * jsdom lacks IntersectionObserver and Element.prototype.scrollIntoView, so
 * both are stubbed. jsdom never fires real intersections, so the active-highlight
 * behaviour is verified by manually invoking the captured observer callback.
 *
 * @vitest-environment jsdom
 */

import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { MarkdownToc } from '@/components/worktree/MarkdownToc';
import type { TocEntry } from '@/lib/markdown-toc';

const ENTRIES: TocEntry[] = [
  { depth: 1, text: 'Title', id: 'title' },
  { depth: 2, text: 'Section A', id: 'section-a' },
  { depth: 3, text: 'Deep', id: 'deep' },
];

// --- IntersectionObserver stub that captures its callback -------------------
type IOCallback = (entries: IntersectionObserverEntry[]) => void;
let lastObserverCallback: IOCallback | null = null;
let lastObserverOptions: IntersectionObserverInit | undefined;
const observeSpy = vi.fn();
const disconnectSpy = vi.fn();

class MockIntersectionObserver {
  constructor(cb: IOCallback, options?: IntersectionObserverInit) {
    lastObserverCallback = cb;
    lastObserverOptions = options;
  }
  observe = observeSpy;
  unobserve = vi.fn();
  disconnect = disconnectSpy;
  takeRecords = vi.fn(() => []);
  root = null;
  rootMargin = '';
  thresholds = [];
}

/** Build a minimal IntersectionObserverEntry for a heading id. */
function makeEntry(id: string, isIntersecting: boolean, top: number): IntersectionObserverEntry {
  return {
    target: { id } as Element,
    isIntersecting,
    boundingClientRect: { top } as DOMRectReadOnly,
    intersectionRatio: isIntersecting ? 1 : 0,
    intersectionRect: {} as DOMRectReadOnly,
    rootBounds: null,
    time: 0,
  } as IntersectionObserverEntry;
}

describe('MarkdownToc', () => {
  beforeEach(() => {
    lastObserverCallback = null;
    lastObserverOptions = undefined;
    observeSpy.mockClear();
    disconnectSpy.mockClear();
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver);
    Element.prototype.scrollIntoView = vi.fn();
    // Provide real heading anchors for getElementById / observe.
    document.body.innerHTML =
      '<h1 id="title">Title</h1><h2 id="section-a">Section A</h2><h3 id="deep">Deep</h3>';
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    document.body.innerHTML = '';
  });

  it('renders a nav labelled by the title with all entries', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" />);
    const nav = screen.getByRole('navigation', { name: 'Contents' });
    expect(nav).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Title' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Section A' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Deep' })).toBeInTheDocument();
  });

  it('renders nothing when there are no entries', () => {
    const { container } = render(<MarkdownToc entries={[]} title="Contents" />);
    expect(container.querySelector('nav')).toBeNull();
  });

  it('indents entries according to depth', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" />);
    const depth1 = screen.getByRole('link', { name: 'Title' });
    const depth3 = screen.getByRole('link', { name: 'Deep' });
    expect(depth1).toHaveAttribute('data-depth', '1');
    expect(depth3).toHaveAttribute('data-depth', '3');
    // Deeper heading has larger left padding.
    const pad1 = parseInt(depth1.style.paddingLeft, 10);
    const pad3 = parseInt(depth3.style.paddingLeft, 10);
    expect(pad3).toBeGreaterThan(pad1);
  });

  it('scrolls to the heading on click', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" />);
    fireEvent.click(screen.getByRole('link', { name: 'Section A' }));
    const heading = document.getElementById('section-a')!;
    expect(heading.scrollIntoView).toHaveBeenCalledWith({
      behavior: 'smooth',
      block: 'start',
    });
  });

  it('marks the clicked entry active (aria-current)', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" />);
    const link = screen.getByRole('link', { name: 'Deep' });
    fireEvent.click(link);
    expect(link).toHaveAttribute('aria-current', 'location');
  });

  it('observes every heading and applies a header-offset rootMargin', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" headerOffset={57} />);
    expect(observeSpy).toHaveBeenCalledTimes(3);
    expect(lastObserverOptions?.rootMargin).toContain('-57px');
  });

  it('highlights the top-most intersecting section via the observer callback', () => {
    render(<MarkdownToc entries={ENTRIES} title="Contents" />);
    expect(lastObserverCallback).toBeTypeOf('function');

    // section-a is the top-most intersecting heading.
    act(() => {
      lastObserverCallback!([
        makeEntry('section-a', true, 40),
        makeEntry('deep', true, 300),
        makeEntry('title', false, -100),
      ]);
    });
    expect(screen.getByRole('link', { name: 'Section A' })).toHaveAttribute(
      'aria-current',
      'location'
    );
    expect(screen.getByRole('link', { name: 'Deep' })).not.toHaveAttribute('aria-current');

    // Scrolling further down makes 'deep' the active section.
    act(() => {
      lastObserverCallback!([makeEntry('deep', true, 20)]);
    });
    expect(screen.getByRole('link', { name: 'Deep' })).toHaveAttribute(
      'aria-current',
      'location'
    );
  });

  it('does not crash when IntersectionObserver is unavailable', () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    expect(() =>
      render(<MarkdownToc entries={ENTRIES} title="Contents" />)
    ).not.toThrow();
    expect(screen.getByRole('navigation', { name: 'Contents' })).toBeInTheDocument();
  });
});
