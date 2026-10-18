/**
 * The split resizer wrapper, moved out of TerminalSplitContainer (Issue #3603).
 */

'use client';

import React, { useCallback } from 'react';
import { PaneResizer, type ResizerOrientation } from '../PaneResizer';

/**
 * Internal helper: wraps PaneResizer so we can intercept the underlying
 * mousedown / touchstart events to mark `isResizing=true` synchronously.
 * `mouseup` clears it.
 *
 * Issue #2421: also carries the grid's two dividers, which differ from the row's
 * only in orientation, track placement and test id — the drag / touch / keyboard
 * machinery is the same `PaneResizer` either way (its `orientation="vertical"`
 * branch had no caller in `src/` before this Issue).
 */
export function PaneResizerWrapper({
  resizerIdx,
  ariaValueNow,
  onResize,
  onStart,
  onEnd,
  onDoubleClick,
  hidden = false,
  orientation = 'horizontal',
  testId,
  gridArea,
}: {
  resizerIdx: number;
  ariaValueNow: number;
  onResize: (resizerIdx: number, delta: number) => void;
  onStart: () => void;
  onEnd: () => void;
  /** Issue #861: double-clicking the resizer equalizes terminal split widths. */
  onDoubleClick?: () => void;
  /** Issue #2261: hidden (but mounted) while a split is maximized. */
  hidden?: boolean;
  /** Issue #2421: `vertical` drives the grid's row divider (row-resize / clientY). */
  orientation?: ResizerOrientation;
  /** Issue #2421: overrides the row layout's positional id for the grid dividers. */
  testId?: string;
  /** Issue #2421: explicit grid placement; omitted in the flex row. */
  gridArea?: { gridColumn: number | string; gridRow: number | string };
}) {
  const handleResize = useCallback(
    (delta: number) => onResize(resizerIdx, delta),
    [resizerIdx, onResize],
  );
  return (
    <div
      data-testid={testId ?? `split-resizer-${resizerIdx}`}
      style={{ ...gridArea, ...(hidden ? { display: 'none' } : null) }}
      onMouseDownCapture={onStart}
      onTouchStartCapture={onStart}
      onMouseUpCapture={onEnd}
      onTouchEndCapture={onEnd}
    >
      <PaneResizer
        onResize={handleResize}
        orientation={orientation}
        ariaValueNow={ariaValueNow}
        onDoubleClick={onDoubleClick}
      />
    </div>
  );
}
