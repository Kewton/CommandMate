/**
 * Tab title, favicon and app badge for "N need your attention" (Issue #1789).
 *
 * One hook, mounted once in the app shell, driving all three of the
 * out-of-page surfaces from the single count in
 * {@link module:hooks/useAttentionCount}. They are together rather than in three
 * hooks because they are one fact shown three ways: any of them disagreeing
 * with the sidebar badge is a bug, and the cheapest way to guarantee agreement
 * is to give them no separate source to drift from.
 *
 * ## Known limitation, stated as accepted behaviour
 *
 * `useWorktreesCache` stops polling while the tab is hidden, so with the
 * WebSocket down the count — and therefore the title and favicon — freeze at
 * whatever they were when you switched away, and catch up on the next
 * foreground. That is accepted rather than worked around: reviving the poller
 * for a hidden tab would undo the very saving that behaviour exists for. With
 * the realtime connection up (Issue #1788 broadcasts the waiting edge) the cache
 * is updated by push and the badge does keep up while hidden — which is the
 * normal case, and the case this feature is for.
 *
 * @module hooks/useAttentionBadge
 */

'use client';

import { useEffect, useRef } from 'react';
import { useAttentionCount } from '@/hooks/useAttentionCount';
import {
  applyAppBadge,
  applyFaviconDataUrl,
  formatTitleWithBadge,
  originalFaviconHref,
  renderFaviconBadgeDataUrl,
  restoreFavicons,
  stripTitleBadge,
  type FaviconSwapRecord,
} from '@/lib/pwa/attention-badge';

export interface UseAttentionBadgeReturn {
  /** The count being reflected, for the caller that wants to assert on it. */
  count: number;
}

export function useAttentionBadge(): UseAttentionBadgeReturn {
  const { count } = useAttentionCount();

  const faviconRecords = useRef<FaviconSwapRecord[]>([]);
  const baseIcon = useRef<HTMLImageElement | null>(null);

  // --- 1. Tab title -------------------------------------------------------
  //
  // Next.js rewrites `document.title` on navigation, from its own effect, with
  // no ordering guarantee against ours — and it may replace the whole <title>
  // element rather than mutate its text. So rather than trying to run last, we
  // watch the head and re-apply. Re-applying is free and, because
  // `formatTitleWithBadge` strips before it prepends, exactly idempotent: our
  // own write produces no further change and the observer settles immediately.
  useEffect(() => {
    if (typeof document === 'undefined') return;

    const apply = () => {
      const next = formatTitleWithBadge(document.title, count);
      if (next !== document.title) document.title = next;
    };

    apply();

    let observer: MutationObserver | null = null;
    if (typeof MutationObserver !== 'undefined' && document.head) {
      observer = new MutationObserver(apply);
      observer.observe(document.head, {
        childList: true,
        subtree: true,
        characterData: true,
      });
    }

    return () => {
      observer?.disconnect();
      const base = stripTitleBadge(document.title);
      if (base !== document.title) document.title = base;
    };
  }, [count]);

  // --- 2. Favicon ---------------------------------------------------------
  useEffect(() => {
    if (typeof document === 'undefined') return;
    if (count <= 0) return; // The previous effect's cleanup already restored it.

    // Captured once: the array's identity never changes (only its contents do),
    // so the cleanup below restores exactly the links this run swapped.
    const records = faviconRecords.current;

    const draw = () => {
      const icon = baseIcon.current;
      const ready = icon && icon.complete && icon.naturalWidth > 0 ? icon : null;
      const dataUrl = renderFaviconBadgeDataUrl(count, { base: ready, document });
      if (!dataUrl) return; // No 2D context / tainted canvas — leave the icon be.
      applyFaviconDataUrl(document, dataUrl, records);
    };

    // First pass, so the badge appears without waiting on the network. It also
    // records the pristine hrefs, which is where the base image's src comes
    // from — read it back rather than from the live link, which now holds our
    // data URL.
    draw();

    let image = baseIcon.current;
    if (!image && typeof Image !== 'undefined') {
      const href = originalFaviconHref(document, records);
      if (href) {
        image = new Image();
        baseIcon.current = image;
        // Same-origin, so the canvas stays untainted and `toDataURL` works.
        image.src = href;
      }
    }

    // Second pass once the real icon is decoded, replacing the plate.
    let onLoad: (() => void) | null = null;
    if (image && !(image.complete && image.naturalWidth > 0)) {
      onLoad = () => draw();
      image.addEventListener('load', onLoad);
    } else if (image) {
      draw();
    }

    return () => {
      if (image && onLoad) image.removeEventListener('load', onLoad);
      restoreFavicons(records);
    };
  }, [count]);

  // --- 3. App badge -------------------------------------------------------
  //
  // No cleanup: the badge is meant to outlive the tab (that is the point of an
  // app badge), and it is cleared by the `count === 0` pass like any other
  // change.
  useEffect(() => {
    applyAppBadge(count);
  }, [count]);

  return { count };
}
