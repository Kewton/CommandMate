/**
 * The 2x2 grid's track placement, moved out of TerminalSplitContainer (Issue #3603).
 */

import type { CSSProperties } from 'react';
import { MIN_GRID_ROW_PX } from '@/config/terminal-split-config';

/**
 * Issue #2421: thickness of the grid's two divider TRACKS, in px.
 *
 * A grid divider needs a track of its own (unlike a flex row, where the resizer
 * is just another `flex-shrink-0` child), and the number has to match the line
 * `PaneResizer` draws — `w-1` / `h-1`, i.e. 4px — or the handle would float
 * inside a wider gap.
 */
export const GRID_DIVIDER_PX = 4;

/** Issue #2421: 2x2 placement — panes 0/1 on the top row, 2/3 on the bottom. */
export function gridColumnOf(idx: number): number {
  // Track 2 is the column divider, so the right-hand column is track 3.
  return idx % 2 === 0 ? 1 : 3;
}

export function gridRowOf(idx: number): number {
  // Track 2 is the row divider, so the bottom row is track 3.
  return idx < 2 ? 1 : 3;
}

/** The 2x2 grid's track template (the splits area's `style` at 4 splits). */
export function gridTemplateStyle(
  isMaximized: boolean,
  gridColumnFr: [number, number],
  gridRowFr: [number, number],
): CSSProperties {
  return {
    // Issue #2421 (trap 2): a grid track survives its children being
    // hidden, so `display: none` alone would leave the maximized
    // pane in the top-left quarter. While maximized the grid IS one
    // cell.
    // Issue #2424: normalised, NOT the raw shares. A fresh grid
    // carries `0.25` per pane, and `0.25fr + 0.25fr` sums to less
    // than 1 — which CSS reads as "take half the leftover space"
    // rather than "split it evenly", leaving the right ~50% blank.
    gridTemplateColumns: isMaximized
      ? '1fr'
      : `${gridColumnFr[0]}fr ${GRID_DIVIDER_PX}px ${gridColumnFr[1]}fr`,
    gridTemplateRows: isMaximized
      ? '1fr'
      : `minmax(${MIN_GRID_ROW_PX}px, ${gridRowFr[0]}fr) ${GRID_DIVIDER_PX}px minmax(${MIN_GRID_ROW_PX}px, ${gridRowFr[1]}fr)`,
  };
}
