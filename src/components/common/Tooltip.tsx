/**
 * Tooltip Component (Issue #730)
 *
 * Lightweight hover-delayed tooltip used by ActivityBar icons (replacing the
 * native `title` attribute which is browser-styled and unreliable).
 *
 * Design notes:
 *   - The wrapper is a `<span>` with `tabIndex={-1}` so it stays out of the
 *     keyboard Tab cycle (the child button is the only focusable target).
 *   - We do NOT clone the child element. The wrapper intercepts mouse events
 *     on its own so ref / onClick / onKeyDown on the child stay transparent.
 *   - The tooltip element has `role="tooltip"` + `aria-hidden="true"`. We
 *     intentionally do NOT wire `aria-describedby` on the child because the
 *     ActivityBar buttons already expose `aria-label` with the same text;
 *     adding `aria-describedby` would cause screen readers to read the label
 *     twice.
 *   - The visibility timer is tracked in a ref so a cleanup effect can call
 *     `clearTimeout` on unmount and avoid setting state on an unmounted
 *     component when the user hovers and quickly navigates away.
 */

'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';

/** Delay in milliseconds before the tooltip becomes visible after hover. */
export const TOOLTIP_DELAY_MS = 100;

/** Supported tooltip placements relative to the wrapped element. */
export type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

export interface TooltipProps {
  /** Tooltip text content. */
  content: string;
  /** Placement relative to the trigger (default: `right`). */
  placement?: TooltipPlacement;
  /** Hover delay in milliseconds (default: `TOOLTIP_DELAY_MS`). */
  delay?: number;
  /** Trigger element (typically a `<button>`). */
  children: React.ReactNode;
}

const PLACEMENT_CLASS: Record<TooltipPlacement, string> = {
  top: 'bottom-full left-1/2 -translate-x-1/2 mb-2',
  right: 'left-full top-1/2 -translate-y-1/2 ml-2',
  bottom: 'top-full left-1/2 -translate-x-1/2 mt-2',
  left: 'right-full top-1/2 -translate-y-1/2 mr-2',
};

/**
 * Hover-delayed tooltip used by ActivityBar.
 *
 * @example
 * ```tsx
 * <Tooltip content="Files" placement="right">
 *   <button aria-label="Files">…</button>
 * </Tooltip>
 * ```
 */
export function Tooltip({
  content,
  placement = 'right',
  delay = TOOLTIP_DELAY_MS,
  children,
}: TooltipProps): React.ReactElement {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      setVisible(true);
      timerRef.current = null;
    }, delay);
  }, [delay, clearTimer]);

  const handleMouseLeave = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  // Cleanup on unmount: guarantee no stray setTimeout fires after we go away.
  // (eslint react-hooks/exhaustive-deps): we intentionally close over the
  // stable clearTimer (memoized with []), so an empty deps array is correct.
  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  const placementClass = PLACEMENT_CLASS[placement];

  return (
    <span
      data-testid="tooltip-wrapper"
      className="relative inline-flex"
      tabIndex={-1}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible && (
        <span
          role="tooltip"
          aria-hidden="true"
          className={`absolute z-40 whitespace-nowrap px-2 py-1 text-xs font-medium rounded bg-gray-900 text-gray-100 shadow-lg pointer-events-none ${placementClass}`}
        >
          {content}
        </span>
      )}
    </span>
  );
}

export default Tooltip;
