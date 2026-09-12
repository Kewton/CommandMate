/**
 * useInViewport — "is this element on screen right now?" (Issue #2509).
 *
 * Written for the `/sessions` tile grid, where every mounted tile owns a live
 * chat surface: `useTerminalPanePolling` (`/current-output`, as often as every
 * 2s) and `useSplitMessages` (`/messages`). Twenty worktrees in two columns is
 * a screen that can show four of them, so mounting all twenty would be forty
 * pollers for the four the reader can actually see. Both hooks already take an
 * `enabled` flag — nothing in them changes — and this is the missing half:
 * the caller-side verdict on which tiles deserve it.
 *
 * ## Why IntersectionObserver and not @tanstack/react-virtual
 *
 * The dependency is already here and would have worked, but virtualization
 * *unmounts* the rows it scrolls past, and a tile is not a row: unmounting it
 * throws away the transcript, the scroll position inside it and the pane state
 * the poller accumulated, so scrolling back would re-attach and re-fetch
 * everything. Observing visibility keeps the component mounted and merely
 * quiets it, which is the behaviour a "watch several sessions" screen wants.
 *
 * ## When there is no IntersectionObserver
 *
 * SSR has none, and neither does jsdom. The fallback is `true` — everything
 * visible — because the failure mode of guessing "visible" is extra polling,
 * while the failure mode of guessing "hidden" is a screen of empty tiles that
 * never fill in. Tests that want to pin the offscreen behaviour install a stub
 * (see `tests/unit/sessions/`), which is also what makes the stub's absence
 * impossible to mistake for a passing assertion.
 *
 * @module hooks/useInViewport
 */

'use client';

import { useCallback, useEffect, useState } from 'react';

/** Options for {@link useInViewport}. */
export interface UseInViewportOptions {
  /**
   * Margin grown around the root before intersection is computed, e.g.
   * `'200px'`. A positive value wakes an element up shortly *before* it
   * scrolls into view, so its first paint is not an empty box.
   */
  rootMargin?: string;
  /** Fraction of the element that must be visible to count. Defaults to 0. */
  threshold?: number;
}

/** What {@link useInViewport} hands back. */
export interface UseInViewportReturn<T extends Element> {
  /** Attach to the element whose visibility is the question. */
  ref: (node: T | null) => void;
  /** Whether that element is currently intersecting the viewport. */
  inViewport: boolean;
}

/**
 * Observe one element's viewport visibility.
 *
 * Starts `false` so a server render (and the first client render) enables
 * nothing; the observer's first callback fires on the frame after the element
 * is attached, so a tile that IS on screen turns on immediately.
 *
 * The returned `ref` is a callback ref rather than an object ref: the observed
 * element belongs to the caller's JSX and can be replaced on re-render, and a
 * callback ref is the only form that is told when that happens.
 *
 * @param options - Observer tuning; see {@link UseInViewportOptions}
 * @returns A ref to attach and the current verdict
 *
 * @example
 * ```tsx
 * const { ref, inViewport } = useInViewport<HTMLDivElement>({ rootMargin: '400px' });
 * return <div ref={ref}><Pane enabled={inViewport} /></div>;
 * ```
 */
export function useInViewport<T extends Element>(
  options: UseInViewportOptions = {},
): UseInViewportReturn<T> {
  const { rootMargin, threshold } = options;
  const [inViewport, setInViewport] = useState(false);
  // Re-runs the effect when the observed element changes identity. State (not a
  // ref) because a callback ref fires outside the render pass, and nothing else
  // would tell the effect below that it now has something to observe.
  const [node, setNode] = useState<T | null>(null);

  const ref = useCallback((next: T | null) => {
    setNode(next);
  }, []);

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined') {
      // No observer: every element counts as visible. See the module comment.
      setInViewport(true);
      return;
    }
    if (!node) return;

    const observer = new IntersectionObserver(
      (entries) => {
        // One element per observer, so the last entry is this element's newest
        // verdict — `entries` can carry several when frames were coalesced.
        const latest = entries[entries.length - 1];
        if (latest) setInViewport(latest.isIntersecting);
      },
      { rootMargin, threshold },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [node, rootMargin, threshold]);

  return { ref, inViewport };
}

export default useInViewport;
