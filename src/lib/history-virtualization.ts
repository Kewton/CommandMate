/**
 * History virtualization tuning + scroll helpers (Issue #1123)
 *
 * The HistoryPane renders conversation pairs with `@tanstack/react-virtual`
 * (variable height via `measureElement`). These constants and the pure
 * `isNearBottom` predicate are extracted so the follow/maintain scroll decision
 * is unit-testable without a real layout engine (jsdom reports zero-sized
 * rects), matching the flavour of the existing FilePanelContent virtualization.
 */

/**
 * Extra rows rendered above and below the visible window. A conversation pair
 * card is comparatively tall, so a small overscan already covers fast flicks
 * while keeping the mounted DOM count low.
 */
export const HISTORY_VIRTUAL_OVERSCAN = 6;

/**
 * Initial per-pair height estimate (px) before `measureElement` reports the
 * real height. Roughly a collapsed user+assistant card incl. the `mb-4` gap.
 * Only affects the scrollbar/initial layout; measured heights supersede it.
 */
export const HISTORY_ESTIMATED_PAIR_HEIGHT_PX = 160;

/**
 * Distance (px) from the bottom within which the view is considered "pinned"
 * to the latest message. While pinned, newly appended messages auto-follow to
 * the bottom; otherwise the current reading position is preserved.
 */
export const HISTORY_STICK_TO_BOTTOM_THRESHOLD_PX = 80;

/**
 * Bounded number of leading pairs rendered in normal flow when the virtualizer
 * has not measured a viewport yet — i.e. it materialized zero rows despite
 * having pairs. This happens on the first render before the layout-effect
 * measurement (SSR / first paint) and in zero-layout environments like jsdom.
 * Rendering a small slice keeps message content present without mounting the
 * whole list; the virtualized list takes over as soon as a real height is
 * measured. Kept small so it never defeats virtualization in production.
 */
export const HISTORY_FALLBACK_RENDER_COUNT = 30;

/** Minimal scroll geometry needed to decide the follow/maintain behaviour. */
export interface ScrollMetrics {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}

/**
 * Returns true when the scroll position is at (or within `threshold` px of) the
 * bottom of the scroll container — i.e. the user is viewing the latest content
 * and new messages should auto-follow.
 *
 * Defensive against transient non-finite geometry (e.g. detached elements):
 * treats it as "not at bottom" so we never yank a reader's position.
 */
export function isNearBottom(
  { scrollTop, scrollHeight, clientHeight }: ScrollMetrics,
  threshold: number = HISTORY_STICK_TO_BOTTOM_THRESHOLD_PX
): boolean {
  const distanceFromBottom = scrollHeight - scrollTop - clientHeight;
  if (!Number.isFinite(distanceFromBottom)) return false;
  return distanceFromBottom <= threshold;
}
