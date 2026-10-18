/**
 * The action bar's "…" overflow button and panel (Issue #3590), moved out of
 * TerminalSplitContainer (Issue #3603).
 */

'use client';

import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Ellipsis } from 'lucide-react';
import { Tooltip } from '@/components/common/Tooltip';
import {
  isCoveredByViewportLayer,
  isUnhandledEscape,
  markEscapeClosedLayer,
} from '@/lib/escape-key';
import { Z_INDEX } from '@/config/z-index';

/** Gap between the "…" panel and the viewport edge, and below the button (px). */
const OVERFLOW_PANEL_MARGIN = 8;
const OVERFLOW_PANEL_GAP = 4;

/**
 * Issue #3590: the "…" panel's left edge — right-aligned with the button when
 * there is room, shifted right as far as needed so its left edge stays inside
 * the viewport, and pinned to the left margin when the panel is wider than the
 * viewport allows (its `max-w` then caps it). The same idea as the repository
 * tab popover's `clampPopoverLeft`, with the preference flipped: this button
 * sits at the right end of its group.
 *
 * Issue #3651: the left limit is the body's left edge (`regionLeft`, the
 * split container's), not the viewport's. With the sidebar open at 1024px the
 * panel is wider than the room left of "…", and a viewport-only clamp drew it
 * from x=8 — over the sidebar.
 *
 * @param buttonRight - The "…" button's viewport `right`
 * @param panelWidth - The panel's rendered width in px
 * @param viewportWidth - `window.innerWidth`
 * @param regionLeft - The body region's viewport `left` (0: the viewport)
 * @returns The `left` coordinate to render at
 * @internal Exported for unit tests.
 */
export function clampOverflowPanelLeft(
  buttonRight: number,
  panelWidth: number,
  viewportWidth: number,
  regionLeft = 0
): number {
  const minLeft = regionLeft + OVERFLOW_PANEL_MARGIN;
  const maxLeft = viewportWidth - OVERFLOW_PANEL_MARGIN - panelWidth;
  if (maxLeft <= minLeft) return minLeft;
  return Math.min(Math.max(buttonRight - panelWidth, minLeft), maxLeft);
}

/**
 * Issue #3651: the panel's `max-width` — the room from the body's left edge to
 * the viewport's right edge, minus a margin on each side. With `regionLeft` 0
 * it is the former `calc(100vw - 16px)`.
 *
 * @internal Exported for unit tests.
 */
export function overflowPanelMaxWidth(viewportWidth: number, regionLeft = 0): number {
  return Math.max(viewportWidth - regionLeft - 2 * OVERFLOW_PANEL_MARGIN, 0);
}

/**
 * Issue #3651: the "…" panel's box. `flex-wrap`: with the width measured from
 * the body (768px with a 480px sidebar leaves ~272px), the items — the chip
 * and the lone split's session controls — go onto further rows instead of
 * overrunning the box or each other. Each row item is capped at the box
 * (`max-w-full`, the chip's own root and the parked session slot) and shrinks
 * by truncating (`min-w-0`); inside the slot the controls wrap too (the
 * pane's row reads the slot's `data-folded`, see `sessionSlot`). Wrapping
 * rather than scrolling, because the panel's job is to show every folded
 * control at once: a scroll box hides part of them behind a scrollbar, a
 * scrolled-away control is reached only by scrolling, and keyboard focus can
 * land on one out of view. (The reason popover — portalled to `<body>` on PC —
 * and the selector's Radix menu — portalled too — would not be clipped by
 * one.) A panel that fits stays one row, as before.
 */
const OVERFLOW_PANEL_CLASS =
  'fixed flex flex-wrap max-w-[calc(100vw-16px)] items-center gap-1 rounded-lg border border-border bg-surface p-1 shadow-lg';

/**
 * Issue #3670: the "…" panel's z-index, inline (not a `z-50` class) so the
 * Escape handler can read where it actually stacks against a viewport layer.
 */
const OVERFLOW_PANEL_Z_INDEX = Z_INDEX.MODAL;

/** Issue #3651: the body region the "…" panel stays inside. */
const OVERFLOW_PANEL_REGION_SELECTOR = '[data-testid="terminal-split-container"]';

/**
 * Issue #3590: the "…" button the action bar's items fold behind when the bar
 * is too narrow (`useSplitActionBarFit`). The panel is portalled to `<body>`
 * with `position: fixed` under the button, so neither the bar's clipped left
 * group nor the terminal pane's `overflow-hidden` (beside an open file panel)
 * can cut it. Its rendered width is measured before paint and its left edge
 * clamped into the viewport on both sides ({@link clampOverflowPanelLeft}).
 * Issue #3651: on the left, into the body — the split container's left edge,
 * so it never covers the sidebar (the viewport when there is no container).
 *
 * Focus follows the repository tab popover: opening moves focus to the
 * panel's first control, Escape closes and hands focus back to "…". A press
 * outside closes without moving focus — the press already put it where the
 * user wanted. A press inside any `[data-floating-layer]` (the chip's reason
 * popover) counts as inside.
 *
 * Issue #3660: while open the panel marks itself `data-floating-layer="open"`
 * like the header tools' "…" list, so the overlaid activity pane stands down:
 * one Escape (or a press outside) closes the panel, not the pane under it. The
 * chip folded in here (an `[data-activity-entry]` of the pane, and the panel's
 * first control) would otherwise close both. The mark, not `preventDefault`:
 * the pane's document listener predates the panel's, and the chip's reason
 * (its document listener comes after the panel's) still closes with the panel
 * on an Escape neither the chip nor anything above claimed.
 *
 * Issue #3670: Escape closes the front layer first. The maximized file
 * (`Z_INDEX.MAXIMIZED_EDITOR`, a `fixed inset-0` portal) covers the panel
 * (`Z_INDEX.MODAL`), so while it does the panel leaves the press alone
 * ({@link isCoveredByViewportLayer}) and the file un-maximizes; the panel,
 * now in sight, closes on the next one. In front of a maximized file, the
 * panel only marks the Escape it closes on ({@link markEscapeClosedLayer}),
 * for the same reason as above, and the file stays maximized.
 *
 * Issue #3592: `parked` is drawn after `children` while the panel is open,
 * and in a hidden box beside the button while it is closed — for a slot
 * another component portals into, which must exist in either state.
 *
 * Exported for tests (Issue #3591: its Esc beside the header tools' "…").
 */
export function ActionBarItemsOverflow({
  label,
  children,
  parked = null,
}: {
  label: string;
  children: ReactNode;
  parked?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{
    top: number;
    left: number;
    maxWidth: number;
  } | null>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const place = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    const panel = panelRef.current;
    if (!rect || !panel) return;
    const width = panel.getBoundingClientRect().width;
    const region = buttonRef.current?.closest(OVERFLOW_PANEL_REGION_SELECTOR);
    const regionLeft = Math.max(region?.getBoundingClientRect().left ?? 0, 0);
    const next = {
      top: rect.bottom + OVERFLOW_PANEL_GAP,
      left: clampOverflowPanelLeft(rect.right, width, window.innerWidth, regionLeft),
      maxWidth: overflowPanelMaxWidth(window.innerWidth, regionLeft),
    };
    setPosition((prev) =>
      prev && prev.top === next.top && prev.left === next.left && prev.maxWidth === next.maxWidth
        ? prev
        : next
    );
  }, []);

  // Measure the rendered panel before paint (it renders hidden until placed),
  // then move focus to its first control.
  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }
    place();
  }, [open, place]);

  // Once per opening, after the panel is placed: a `visibility: hidden` panel
  // (the first, unmeasured render) cannot take focus.
  const placed = position !== null;
  const focusedRef = useRef(false);
  useEffect(() => {
    if (!open) {
      focusedRef.current = false;
      return;
    }
    if (!placed || focusedRef.current) return;
    focusedRef.current = true;
    const first = panelRef.current?.querySelector<HTMLElement>(
      'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    first?.focus();
  }, [open, placed]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target) return;
      if (buttonRef.current?.contains(target) || panelRef.current?.contains(target)) return;
      if (typeof target.closest === 'function' && target.closest('[data-floating-layer]')) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      // Issue #3592: an Escape a layer in the panel already handled (the
      // folded agent selector's menu closing itself) is not ours to act on.
      // Issue #3591: nor one the header tools' "…" list closed itself with.
      if (!isUnhandledEscape(event)) return;
      // Issue #3670: behind a maximized file the press is the file's to close.
      if (panelRef.current && isCoveredByViewportLayer(panelRef.current)) return;
      // In front of one, tell it (a window listener) that this press is spent
      // — without claiming it from the chip's reason.
      markEscapeClosedLayer(event);
      setOpen(false);
      buttonRef.current?.focus();
    };
    // The panel's content can change width (the chip's verdict) and the
    // button can move; re-measure on both, and on window resizes.
    const observer =
      typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => place());
    if (observer && panelRef.current) observer.observe(panelRef.current);
    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    window.addEventListener('resize', place);
    return () => {
      observer?.disconnect();
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('resize', place);
    };
  }, [open, place]);

  return (
    <>
      <Tooltip content={label} placement="bottom" className="flex-shrink-0">
        <button
          ref={buttonRef}
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-label={label}
          aria-expanded={open}
          aria-haspopup="dialog"
          data-testid="split-action-bar-items-overflow"
          className="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded text-muted-foreground hover:text-surface-foreground hover:bg-muted focus:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
        >
          <Ellipsis className="w-4 h-4" aria-hidden="true" />
        </button>
      </Tooltip>
      {!open && parked ? <div hidden>{parked}</div> : null}
      {open &&
        typeof document !== 'undefined' &&
        createPortal(
          <div
            ref={panelRef}
            role="dialog"
            aria-label={label}
            data-testid="split-action-bar-items-panel"
            data-floating-layer="open"
            style={
              position
                ? {
                    top: position.top,
                    left: position.left,
                    maxWidth: position.maxWidth,
                    zIndex: OVERFLOW_PANEL_Z_INDEX,
                  }
                : { top: 0, left: 0, visibility: 'hidden', zIndex: OVERFLOW_PANEL_Z_INDEX }
            }
            className={OVERFLOW_PANEL_CLASS}
          >
            {children}
            {parked}
          </div>,
          document.body
        )}
    </>
  );
}
