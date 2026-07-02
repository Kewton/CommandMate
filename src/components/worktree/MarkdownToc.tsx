/**
 * MarkdownToc (Issue #1007)
 *
 * Renders a side table-of-contents for the read-only markdown file viewer.
 * - Lists headings, indented by depth.
 * - Clicking an entry smooth-scrolls to the heading (`scroll-margin-top` on the
 *   rendered headings keeps them clear of the sticky page header).
 * - A scroll-spy (`IntersectionObserver`) highlights the entry for the section
 *   currently in view. The observer's top `rootMargin` is offset by the sticky
 *   header height so a heading hidden behind the header is not counted as
 *   "in view".
 * - The observer's `root` defaults to the viewport, matching the standalone
 *   file viewer page. The optional `root` prop lets an embedded, independently
 *   scrolling pane (e.g. the worktree inline Markdown preview, Issue #1009)
 *   pass its own scroll container instead (back-compat: omitting it keeps the
 *   original viewport-root behaviour, Issue #1007).
 *
 * SSR / test safe: guards `typeof IntersectionObserver` before use.
 */

'use client';

import React, { useEffect, useRef, useState } from 'react';
import type { TocEntry } from '@/lib/markdown-toc';

export interface MarkdownTocProps {
  /** Headings to list. */
  entries: TocEntry[];
  /** Accessible label / visible title for the navigation. */
  title: string;
  /** Height (px) of the sticky page header, used for scroll-spy offset. */
  headerOffset?: number;
  /**
   * Scroll-spy `IntersectionObserver` root. Pass the scrolling pane element
   * when the TOC lives inside its own scroll container (rather than the page
   * viewport). Defaults to `null` (viewport root), matching prior behaviour.
   */
  root?: HTMLElement | null;
  /** Optional extra class names for the wrapper. */
  className?: string;
}

const DEFAULT_HEADER_OFFSET = 64;

/**
 * Pick the entry that should be highlighted from a set of observer entries:
 * the top-most heading currently intersecting the (header-offset) viewport.
 */
function pickActiveId(observerEntries: IntersectionObserverEntry[]): string | null {
  const visible = observerEntries
    .filter((entry) => entry.isIntersecting)
    .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
  return visible.length > 0 ? visible[0].target.id : null;
}

export function MarkdownToc({
  entries,
  title,
  headerOffset = DEFAULT_HEADER_OFFSET,
  root = null,
  className = '',
}: MarkdownTocProps) {
  const [activeId, setActiveId] = useState<string | null>(null);
  // Keep the latest activeId available to the observer callback without
  // re-subscribing on every change.
  const activeIdRef = useRef<string | null>(null);
  activeIdRef.current = activeId;

  useEffect(() => {
    if (typeof IntersectionObserver === 'undefined' || entries.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (observerEntries) => {
        const next = pickActiveId(observerEntries);
        if (next) {
          setActiveId(next);
        }
      },
      {
        root,
        // Shift the top edge down by the sticky header height so headings behind
        // the header do not register as "in view".
        rootMargin: `-${headerOffset}px 0px -70% 0px`,
        threshold: 0,
      }
    );

    const observed: Element[] = [];
    for (const entry of entries) {
      const el = document.getElementById(entry.id);
      if (el) {
        observer.observe(el);
        observed.push(el);
      }
    }

    return () => {
      observer.disconnect();
      observed.length = 0;
    };
  }, [entries, headerOffset, root]);

  const handleClick = (event: React.MouseEvent<HTMLAnchorElement>, id: string) => {
    event.preventDefault();
    const el = typeof document !== 'undefined' ? document.getElementById(id) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
    setActiveId(id);
  };

  if (entries.length === 0) {
    return null;
  }

  return (
    <nav aria-label={title} className={className}>
      <p className="px-3 pb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">
        {title}
      </p>
      <ul className="space-y-0.5 text-sm">
        {entries.map((entry, index) => {
          const isActive = entry.id === activeId;
          return (
            <li key={`${entry.id}-${index}`}>
              <a
                href={`#${entry.id}`}
                onClick={(event) => handleClick(event, entry.id)}
                aria-current={isActive ? 'location' : undefined}
                data-depth={entry.depth}
                style={{ paddingLeft: `${(entry.depth - 1) * 12 + 12}px` }}
                className={[
                  'block truncate rounded py-1 pr-2 transition-colors',
                  isActive
                    ? 'bg-blue-50 font-medium text-blue-700'
                    : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900',
                ].join(' ')}
                title={entry.text}
              >
                {entry.text}
              </a>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

export default MarkdownToc;
