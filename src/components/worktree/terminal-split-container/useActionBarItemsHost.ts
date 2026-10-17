/**
 * The host element the action bar's items are rendered into once and moved
 * between the bar and the "…" panel (Issue #3592), moved out of
 * TerminalSplitContainer (Issue #3603).
 */

'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';

export function useActionBarItemsHost() {
  /*
   * Issue #3592: the items (the Verification chip) are rendered ONCE, into a
   * host element this bar owns, and that element is moved between the places
   * they are shown — inline in the left group, or the "…" panel when folded.
   * Rendering `{actionBarItems}` in each place re-created the chip at every
   * move, and with it its open reason; a move is now a DOM move, so the chip
   * keeps its state through the fit's steps and the split count's changes
   * (the count re-keys the fit). In the bar the host itself is the items'
   * 360px box (`split-action-bar-items`), a child of the left group placed
   * right after a hidden anchor; in the panel it is `display: contents` inside
   * the panel's place — so each place lays the items out exactly as before.
   * Attached from the places' ref callbacks — during the commit, before the
   * fit measures — and taken out of the left group when its anchor goes.
   */
  const [itemsHost, setItemsHost] = useState<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    setItemsHost(document.createElement('div'));
  }, []);
  const itemsAnchorRef = useRef<HTMLElement | null>(null);
  const attachItemsInline = useCallback(
    (anchor: HTMLSpanElement | null) => {
      const previous = itemsAnchorRef.current;
      itemsAnchorRef.current = anchor;
      if (!itemsHost) return;
      if (!anchor) {
        // The anchor is leaving: the host must not stay behind in the group.
        if (previous && itemsHost.previousSibling === previous) itemsHost.remove();
        return;
      }
      // Same width rule the header gave the chip (#2481): a 360px `w-*` capped
      // by `max-w-max`, `min-w-0` so its title truncates.
      itemsHost.className = 'ml-1 flex min-w-0 w-[360px] max-w-max items-center gap-1';
      itemsHost.style.display = '';
      itemsHost.setAttribute('data-testid', 'split-action-bar-items');
      if (itemsHost.previousSibling !== anchor) anchor.after(itemsHost);
    },
    [itemsHost],
  );
  const attachItemsFolded = useCallback(
    (place: HTMLDivElement | null) => {
      if (!place || !itemsHost) return;
      itemsHost.className = '';
      itemsHost.style.display = 'contents';
      itemsHost.removeAttribute('data-testid');
      if (itemsHost.parentNode !== place) place.appendChild(itemsHost);
    },
    [itemsHost],
  );

  return { itemsHost, attachItemsInline, attachItemsFolded };
}
