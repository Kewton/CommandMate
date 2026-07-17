/**
 * TruncationTooltip Component (Issue #859, #975)
 *
 * A hover-delayed tooltip for text that is visually truncated (CSS
 * `text-overflow: ellipsis`). It replaces the native `title` attribute on
 * file names in the file tree, whose show-delay is browser-controlled and
 * sluggish (~0.5–1s in Chrome) and cannot be tuned from JS/CSS.
 *
 * [Issue #975] An optional `metadata` prop lets a caller surface extra
 * formatted info (e.g. a file's size / created / modified lines) inside the
 * SAME bubble as the name, so a single styled tooltip replaces the previous
 * two independent ones (native `title` metadata + this name tooltip).
 *
 * Design notes:
 *   - The trigger is the truncating element itself (the caller passes the
 *     same `truncate`/`overflow-hidden` className it used before), so we can
 *     measure `scrollWidth > clientWidth` to decide whether the text is
 *     actually clipped. Short names that fit never show a tooltip — unless
 *     `metadata` is supplied, in which case the bubble always appears on hover
 *     so the metadata is reachable even for short, non-clipped names.
 *   - The tooltip is rendered through a React portal to `document.body` with
 *     `position: fixed`, mirroring `BranchListItem`'s approach, so it is never
 *     clipped by the file tree's `overflow-y: auto` scroll container.
 *   - [Issue #1365] The bubble sits below the trigger and is clamped
 *     horizontally at show time. Its height is only knowable once rendered, so
 *     a second measuring pass flips it above the trigger when it would spill
 *     past the bottom of the viewport (a row near the foot of the file tree
 *     with several metadata lines).
 *   - The default delay is 200ms (see issue): long enough to avoid flicker on
 *     fast pointer moves, short enough to feel responsive.
 *   - The tooltip element is `aria-hidden` and the trigger gains no
 *     `aria-describedby`: the visible text node is already announced by screen
 *     readers, so wiring the tooltip into the a11y tree would double-read the
 *     name. This is the same rationale as the common `Tooltip` (#730).
 *   - The show timer lives in a ref and is cleared on mouse leave and unmount
 *     so no state update fires on an unmounted component.
 */

'use client';

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

/** Default delay (ms) before the tooltip becomes visible after hover. */
export const TRUNCATION_TOOLTIP_DELAY_MS = 200;

/** Max tooltip width in px (Tailwind `max-w-md` = 24rem) used for edge clamping. */
const TOOLTIP_MAX_WIDTH = 384;

/** Gap (px) between the trigger and the tooltip. */
const TOOLTIP_GAP = 4;

interface Coords {
  top: number;
  left: number;
}

export interface TruncationTooltipProps {
  /** Full text shown in the tooltip when the trigger is truncated. */
  content: string;
  /** Hover delay in milliseconds (default: `TRUNCATION_TOOLTIP_DELAY_MS`). */
  delay?: number;
  /** className applied to the truncating trigger element. */
  className?: string;
  /**
   * Rendered trigger content (e.g. highlighted markup). Falls back to
   * `content` when omitted.
   */
  children?: React.ReactNode;
  /**
   * [Issue #975] Optional pre-formatted metadata (newline-separated lines)
   * rendered below the name inside the same bubble. When present, the tooltip
   * shows on hover even if the name is not truncated, so callers can attach
   * always-available info (e.g. file size / created / modified). Omit it for a
   * name-only tooltip (the default truncation behavior is unchanged).
   */
  metadata?: string;
}

/**
 * Hover-delayed, portal-rendered tooltip that appears only when the wrapped
 * text is truncated.
 *
 * @example
 * ```tsx
 * <TruncationTooltip content={item.name} className="flex-1 truncate text-sm">
 *   {item.name}
 * </TruncationTooltip>
 * ```
 */
export function TruncationTooltip({
  content,
  delay = TRUNCATION_TOOLTIP_DELAY_MS,
  className,
  children,
  metadata,
}: TruncationTooltipProps): React.ReactElement {
  const triggerRef = useRef<HTMLSpanElement>(null);
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Vertical extent of the trigger captured when the tooltip is shown, so the
  // flip pass below can position the bubble relative to it. [Issue #1365]
  const anchorRef = useRef<{ top: number; bottom: number } | null>(null);
  const [visible, setVisible] = useState(false);
  // Start off-screen so the tooltip is never briefly painted at (0,0)
  // before its coordinates are computed.
  const [coords, setCoords] = useState<Coords>({ top: -9999, left: -9999 });

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const handleMouseEnter = useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    // Show when the name is actually clipped OR when there is metadata to
    // surface (file rows attach metadata so their info is reachable on hover
    // even when the name itself fits). [Issue #975]
    const isTruncated = el.scrollWidth > el.clientWidth;
    if (!isTruncated && !metadata) return;

    clearTimer();
    timerRef.current = setTimeout(() => {
      const rect = el.getBoundingClientRect();
      // Clamp horizontally so a long name near the right edge stays on screen.
      const maxLeft =
        typeof window !== 'undefined'
          ? Math.max(TOOLTIP_GAP, window.innerWidth - TOOLTIP_MAX_WIDTH - TOOLTIP_GAP)
          : rect.left;
      anchorRef.current = { top: rect.top, bottom: rect.bottom };
      setCoords({
        top: rect.bottom + TOOLTIP_GAP,
        left: Math.min(rect.left, maxLeft),
      });
      setVisible(true);
      timerRef.current = null;
    }, delay);
  }, [clearTimer, delay, metadata]);

  /**
   * [Issue #1365] Second pass, once the bubble has real dimensions: if it would
   * run past the bottom of the viewport, flip it above the trigger; if it does
   * not fit there either (a bubble taller than the space above), pin it to the
   * bottom edge so its head stays reachable. Runs in a layout effect so the
   * corrected position is painted in the same frame as the bubble itself.
   * `left` is untouched — the horizontal clamp above already owns that axis.
   */
  useLayoutEffect(() => {
    if (!visible) return;
    const bubble = bubbleRef.current;
    const anchor = anchorRef.current;
    if (!bubble || !anchor) return;
    const { height } = bubble.getBoundingClientRect();
    // jsdom (and a not-yet-laid-out bubble) reports 0 — nothing to correct.
    if (height <= 0) return;
    const viewportHeight = window.innerHeight;
    if (anchor.bottom + TOOLTIP_GAP + height + TOOLTIP_GAP <= viewportHeight) return;
    const above = anchor.top - TOOLTIP_GAP - height;
    const top =
      above >= TOOLTIP_GAP
        ? above
        : Math.max(TOOLTIP_GAP, viewportHeight - height - TOOLTIP_GAP);
    setCoords((prev) => (prev.top === top ? prev : { ...prev, top }));
  }, [visible]);

  const handleMouseLeave = useCallback(() => {
    clearTimer();
    setVisible(false);
  }, [clearTimer]);

  // Cleanup on unmount: guarantee no stray setTimeout fires after we go away.
  useEffect(() => () => clearTimer(), [clearTimer]);

  return (
    <span
      ref={triggerRef}
      className={className}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children ?? content}
      {visible &&
        typeof document !== 'undefined' &&
        createPortal(
          <span
            ref={bubbleRef}
            role="tooltip"
            aria-hidden="true"
            className="fixed z-[9999] max-w-md px-2 py-1 text-xs font-medium rounded bg-foreground text-background shadow-lg pointer-events-none"
            style={{ top: coords.top, left: coords.left }}
          >
            <span className="block break-all">{content}</span>
            {metadata && (
              <span className="mt-0.5 block whitespace-pre-line font-normal text-background/70">
                {metadata}
              </span>
            )}
          </span>,
          document.body
        )}
    </span>
  );
}

export default TruncationTooltip;
