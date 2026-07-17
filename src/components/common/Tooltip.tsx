/**
 * Tooltip Component (Issue #730, #1341, #1364)
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
 *   - [Issue #1341, #1364] The bubble is rendered through a React portal to
 *     `document.body` with `position: fixed` and coordinates computed from the
 *     trigger rect, mirroring `TruncationTooltip`. Previously it was an
 *     `absolute`-positioned child, so a `bottom` tooltip on a narrow sidebar
 *     (default 224px, min 160px) was clipped by the ancestor's bounds and by
 *     the viewport edge. Positions are clamped into the viewport instead of
 *     pulling in a collision-detection library, which would require cloning
 *     the child and break the a11y design above.
 *   - The visibility timer is tracked in a ref so a cleanup effect can call
 *     `clearTimeout` on unmount and avoid setting state on an unmounted
 *     component when the user hovers and quickly navigates away.
 */

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Delay in milliseconds before the tooltip becomes visible after hover. */
export const TOOLTIP_DELAY_MS = 100;

/** Gap (px) between the trigger and the bubble (matches the former `mt-2`/`ml-2`). */
export const TOOLTIP_GAP = 8;

/** Minimum distance (px) kept between the bubble and each viewport edge. */
export const TOOLTIP_VIEWPORT_MARGIN = 4;

/** Supported tooltip placements relative to the wrapped element. */
export type TooltipPlacement = 'top' | 'right' | 'bottom' | 'left';

/** Minimal rect shape needed to place a tooltip (a `DOMRect` subset). */
export interface TooltipRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** Width/height pair (bubble size or viewport size). */
export interface TooltipSize {
  width: number;
  height: number;
}

/** Viewport-relative `position: fixed` coordinates for the bubble. */
export interface TooltipCoords {
  top: number;
  left: number;
}

/**
 * Clamp one axis so the bubble stays inside the viewport.
 *
 * When the bubble is larger than the viewport on that axis it is pinned to the
 * leading margin (clipping the trailing side) rather than jumping off-screen.
 */
function clampAxis(value: number, bubbleSize: number, viewportSize: number): number {
  const max = Math.max(TOOLTIP_VIEWPORT_MARGIN, viewportSize - bubbleSize - TOOLTIP_VIEWPORT_MARGIN);
  return Math.min(Math.max(value, TOOLTIP_VIEWPORT_MARGIN), max);
}

/**
 * Compute the bubble's viewport-relative position for a placement, clamped so
 * it never overflows a viewport edge. [Issue #1341, #1364]
 *
 * `top`/`bottom` centre horizontally on the trigger and `left`/`right` centre
 * vertically — the same anchoring the old `-translate-x-1/2` / `-translate-y-1/2`
 * utility classes produced — but the result is then clamped, which the pure-CSS
 * version could not do.
 *
 * Exported for unit testing (jsdom reports every rect as zero-sized).
 */
export function computeTooltipPosition(
  placement: TooltipPlacement,
  trigger: TooltipRect,
  bubble: TooltipSize,
  viewport: TooltipSize
): TooltipCoords {
  const centeredLeft = trigger.left + trigger.width / 2 - bubble.width / 2;
  const centeredTop = trigger.top + trigger.height / 2 - bubble.height / 2;

  let top: number;
  let left: number;

  switch (placement) {
    case 'top':
      top = trigger.top - bubble.height - TOOLTIP_GAP;
      left = centeredLeft;
      break;
    case 'bottom':
      top = trigger.top + trigger.height + TOOLTIP_GAP;
      left = centeredLeft;
      break;
    case 'left':
      top = centeredTop;
      left = trigger.left - bubble.width - TOOLTIP_GAP;
      break;
    case 'right':
    default:
      top = centeredTop;
      left = trigger.left + trigger.width + TOOLTIP_GAP;
      break;
  }

  return {
    top: clampAxis(top, bubble.height, viewport.height),
    left: clampAxis(left, bubble.width, viewport.width),
  };
}

/** Rendered off-screen for the first frame, before the bubble can be measured. */
const OFFSCREEN_COORDS: TooltipCoords = { top: -9999, left: -9999 };

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
  const [coords, setCoords] = useState<TooltipCoords | null>(null);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
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
    setCoords(null);
  }, [clearTimer]);

  const updatePosition = useCallback(() => {
    const trigger = wrapperRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const triggerRect = trigger.getBoundingClientRect();
    const bubbleRect = bubble.getBoundingClientRect();
    setCoords(
      computeTooltipPosition(
        placement,
        {
          top: triggerRect.top,
          left: triggerRect.left,
          width: triggerRect.width,
          height: triggerRect.height,
        },
        { width: bubbleRect.width, height: bubbleRect.height },
        { width: window.innerWidth, height: window.innerHeight }
      )
    );
  }, [placement]);

  // Measure and place before paint so the bubble is never seen at its
  // off-screen seed position. While visible, keep it anchored across scrolls of
  // any ancestor (capture phase) and viewport resizes — `position: fixed` does
  // not follow the trigger the way the old `absolute` child did.
  useLayoutEffect(() => {
    if (!visible) return;
    updatePosition();
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition, true);
    return () => {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition, true);
    };
  }, [visible, updatePosition]);

  // Cleanup on unmount: guarantee no stray setTimeout fires after we go away.
  // (eslint react-hooks/exhaustive-deps): we intentionally close over the
  // stable clearTimer (memoized with []), so an empty deps array is correct.
  useEffect(() => {
    return () => {
      clearTimer();
    };
  }, [clearTimer]);

  return (
    <span
      ref={wrapperRef}
      data-testid="tooltip-wrapper"
      className="relative inline-flex"
      tabIndex={-1}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            aria-hidden="true"
            data-placement={placement}
            className="fixed z-40 whitespace-nowrap px-2 py-1 text-xs font-medium rounded bg-foreground text-background shadow-lg pointer-events-none"
            style={coords ?? OFFSCREEN_COORDS}
          >
            {content}
          </span>,
          document.body
        )}
    </span>
  );
}

export default Tooltip;
