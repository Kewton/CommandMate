/**
 * Escape-key helper for stacked dismissable layers (Issue #3611).
 *
 * A list, popover or tooltip that closes on a document / window `keydown`
 * Escape must stand down when a layer above it already handled that same
 * press — a Radix menu closing itself, or the header tools' "…" list — which
 * those layers signal with `preventDefault`. Without this check one Escape
 * closes the layer above and everything underneath with it.
 */

/** True when `event` is an Escape no other layer has claimed yet. */
export function isUnhandledEscape(event: KeyboardEvent): boolean {
  return event.key === 'Escape' && !event.defaultPrevented;
}
