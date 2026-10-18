/**
 * TerminalSplitContainer's resize handlers (the flex row's, and the 2x2 grid's
 * two dividers), moved out of it (Issue #3603).
 */

'use client';

import { useCallback, type RefObject } from 'react';
import { toGridTrackFractions } from '@/config/terminal-split-config';
import type { UseTerminalSplitsReturn } from '@/hooks/useTerminalSplits';

export type UseSplitResizeHandlersArgs = Pick<
  UseTerminalSplitsReturn,
  'widths' | 'rowHeights' | 'setSplitWidth' | 'setRowHeights'
> & {
  containerRef: RefObject<HTMLDivElement | null>;
};

export function useSplitResizeHandlers({
  containerRef,
  widths,
  rowHeights,
  setSplitWidth,
  setRowHeights,
}: UseSplitResizeHandlersArgs) {
  const handleResize = useCallback(
    (resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const sum = widths.reduce((s, x) => s + x, 0);
      const percentDelta = (deltaPx / w) * sum;
      const next = [...widths];
      const left = next[resizerIdx] + percentDelta;
      const right = next[resizerIdx + 1] - percentDelta;
      // Don't shrink either side past a tiny floor.
      const FLOOR = sum * 0.05;
      if (left < FLOOR || right < FLOOR) return;
      next[resizerIdx] = left;
      next[resizerIdx + 1] = right;
      setSplitWidth(next);
    },
    [widths, setSplitWidth, containerRef],
  );

  /*
   * Issue #2421: the grid's two dividers.
   *
   * They cannot reuse `handleResize`: that one walks a 1-D `widths` array where
   * every entry spans the container, while a grid has ONE column ratio
   * (`widths[0] : widths[1]`, shared by both rows because a grid column is) and
   * one row ratio. Feeding it `resizerIdx` would move the boundary at twice the
   * pointer's speed, because the sum it divides by (1.0, all four entries) is
   * twice the share the two visible columns actually occupy.
   */
  /*
   * Issue #2424: the `fr` pairs the grid is actually laid out with.
   *
   * `widths` / `rowHeights` are shares whose total is not pinned to 1 (a fresh
   * grid is `0.25` per pane, and `isValidRowHeights` accepts any positive
   * pair). CSS gives tracks whose flex factors sum below 1 only that fraction
   * of the space, so the raw values have to be normalised before they reach
   * `gridTemplate*`. Derived rather than stored: the resize handlers stay free
   * to preserve whatever total they already use.
   */
  const gridColumnFr = toGridTrackFractions(widths[0] ?? 1, widths[1] ?? 1);
  const gridRowFr = toGridTrackFractions(rowHeights[0] ?? 1, rowHeights[1] ?? 1);

  const handleGridColumnResize = useCallback(
    (_resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const w = container.offsetWidth;
      if (w === 0) return;
      const total = widths[0] + widths[1];
      if (!(total > 0)) return;
      const percentDelta = (deltaPx / w) * total;
      const left = widths[0] + percentDelta;
      const right = widths[1] - percentDelta;
      const FLOOR = total * 0.05;
      if (left < FLOOR || right < FLOOR) return;
      // The bottom row mirrors the top so every entry still describes its own
      // pane's horizontal share (the grid reads the ratio off the first two).
      setSplitWidth([left, right, left, right]);
    },
    [widths, setSplitWidth, containerRef],
  );

  const handleGridRowResize = useCallback(
    (_resizerIdx: number, deltaPx: number) => {
      const container = containerRef.current;
      if (!container) return;
      const h = container.offsetHeight;
      if (h === 0) return;
      const total = rowHeights[0] + rowHeights[1];
      if (!(total > 0)) return;
      const percentDelta = (deltaPx / h) * total;
      const top = rowHeights[0] + percentDelta;
      const bottom = rowHeights[1] - percentDelta;
      const FLOOR = total * 0.05;
      if (top < FLOOR || bottom < FLOOR) return;
      setRowHeights([top, bottom]);
    },
    [rowHeights, setRowHeights, containerRef],
  );

  return {
    handleResize,
    gridColumnFr,
    gridRowFr,
    handleGridColumnResize,
    handleGridRowResize,
  };
}
