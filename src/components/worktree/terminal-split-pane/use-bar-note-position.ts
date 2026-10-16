/**
 * Issue #3592: where the session-note editor sits when it is drawn in the action bar.
 */

'use client';

import { useLayoutEffect, useState, type RefObject } from 'react';

export function useBarNotePosition(
  noteEditing: boolean,
  inActionBar: boolean,
  headerSlots: unknown,
  barSessionRef: RefObject<HTMLDivElement | null>,
  BAR_NOTE_EDITOR_WIDTH: number,
  BAR_NOTE_EDITOR_MARGIN: number,
): { top: number; left: number } | null {
  const [barNotePosition, setBarNotePosition] = useState<{ top: number; left: number } | null>(
    null,
  );
  useLayoutEffect(() => {
    if (!noteEditing || !inActionBar) {
      setBarNotePosition(null);
      return;
    }
    let frame = 0;
    const place = () => {
      const anchor = barSessionRef.current;
      const rect = anchor?.getBoundingClientRect();
      // Hidden (display: none, so no client rects) or gone: no position.
      if (!anchor || !rect || anchor.getClientRects().length === 0) {
        setBarNotePosition((prev) => (prev === null ? prev : null));
        return;
      }
      const top = rect.bottom + 4;
      const left = Math.max(
        BAR_NOTE_EDITOR_MARGIN,
        Math.min(rect.left, window.innerWidth - BAR_NOTE_EDITOR_WIDTH - BAR_NOTE_EDITOR_MARGIN),
      );
      setBarNotePosition((prev) =>
        prev && prev.top === top && prev.left === left ? prev : { top, left },
      );
    };
    const follow = () => {
      place();
      frame = window.requestAnimationFrame(follow);
    };
    place();
    frame = window.requestAnimationFrame(follow);
    return () => window.cancelAnimationFrame(frame);
    // `headerSlots`: a new slot is a new place, measured before paint.
  }, [noteEditing, inActionBar, headerSlots, barSessionRef, BAR_NOTE_EDITOR_WIDTH, BAR_NOTE_EDITOR_MARGIN]);
  return barNotePosition;
}
