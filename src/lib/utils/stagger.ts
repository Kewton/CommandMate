/**
 * [Issue #1050] List entrance stagger helpers.
 *
 * Combines tailwindcss-animate entrance classes with a per-item animation
 * delay. `fill-mode-backwards` holds the hidden start frame only during the
 * delay window and reverts to base styles once the entrance finishes, so a
 * later `:hover` transform (e.g. interactive cards) is not clobbered by the
 * animation's fill state.
 *
 * Re-render safety: the animation is bound to element mount. As long as list
 * items keep stable React keys (their DOM nodes are reconciled, not remounted),
 * a polling / WebSocket re-render does NOT restart the entrance animation.
 */

/** Entrance animation classes shared by staggered lists. */
export const STAGGER_ENTER_CLASS =
  'animate-in fade-in-0 slide-in-from-bottom-2 fill-mode-backwards duration-300';

/** Delay between consecutive items, in milliseconds. */
export const STAGGER_STEP_MS = 40;

/** Only the first N items are staggered; the rest share a zero delay. */
export const STAGGER_MAX_ITEMS = 10;

/**
 * Compute the `animation-delay` for a list item at `index`.
 *
 * Returns `undefined` (i.e. no delay / 0ms) for the first item and for items
 * beyond {@link STAGGER_MAX_ITEMS}, so long lists don't accrue a large trailing
 * delay.
 */
export function staggerDelay(
  index: number,
  stepMs: number = STAGGER_STEP_MS,
  maxItems: number = STAGGER_MAX_ITEMS
): string | undefined {
  if (!Number.isFinite(index) || index <= 0 || index >= maxItems) {
    return undefined;
  }
  return `${index * stepMs}ms`;
}
