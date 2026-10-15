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

/**
 * Escapes a layer closed on without claiming them (Issue #3670). Weak, so a
 * mark lives exactly as long as the event it was put on.
 */
const closedLayerEscapes = new WeakSet<KeyboardEvent>();

/**
 * Note that a layer closed on `event` while leaving it unclaimed (Issue #3670).
 *
 * For a layer that must not `preventDefault` — the second row's "…" panel,
 * whose Escape the chip's reason (a sibling layer listening on document after
 * it) still has to close on — yet must not let the press also undo a mode
 * underneath it (a maximized file, listening on window).
 * {@link isUnhandledEscape} ignores the mark; {@link isEscapeNoLayerClosed}
 * reads it.
 */
export function markEscapeClosedLayer(event: KeyboardEvent): void {
  closedLayerEscapes.add(event);
}

/**
 * True when `event` is an Escape nobody claimed and no layer closed on
 * (Issue #3670): the check for a mode under every floating layer, like a
 * maximized file, that should be the last thing one Escape undoes.
 */
export function isEscapeNoLayerClosed(event: KeyboardEvent): boolean {
  return isUnhandledEscape(event) && !closedLayerEscapes.has(event);
}

/**
 * Attribute a layer covering the whole viewport carries (Issue #3670): the
 * maximized file overlay (`fixed inset-0`, portalled to `<body>`).
 */
export const VIEWPORT_LAYER_ATTRIBUTE = 'data-viewport-layer';

function stackOrder(element: Element): number | null {
  const z = Number.parseInt(getComputedStyle(element).zIndex, 10);
  return Number.isNaN(z) ? null : z;
}

/**
 * True when a viewport layer is drawn over `element` (Issue #3670), read from
 * the z-index both actually have — higher, or equal and later in the document.
 * Both must be in the root stacking context (portalled to `<body>`), as the
 * second row's "…" panel and the maximized file are. A layer behind it is not
 * the front one: an Escape is the front layer's to close on first.
 */
export function isCoveredByViewportLayer(element: Element): boolean {
  const own = stackOrder(element);
  if (own === null) return false;
  return Array.from(document.querySelectorAll(`[${VIEWPORT_LAYER_ATTRIBUTE}]`)).some((layer) => {
    if (layer.contains(element) || element.contains(layer)) return false;
    const z = stackOrder(layer);
    if (z === null) return false;
    return (
      z > own ||
      (z === own &&
        (element.compareDocumentPosition(layer) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0)
    );
  });
}

/**
 * True when a viewport layer is drawn over `element`, which sits inside a
 * screen that is itself a viewport layer (FileViewer's screens, Issue #3691;
 * the PC file panel's maximized file, Issue #3700) with no z-index of its own
 * on `element`. Two ways: a root-level layer over the hosting screen (the
 * embedded editor's CSS-fallback maximize, a body portal at the same z, later
 * in the document), or one nested in the screen that is not `element`'s
 * ancestor (the native-fullscreen editor, maximized in place and in the
 * browser's top layer). Outside a screen (a modal, an unmaximized panel) there
 * is nothing to cover it.
 */
export function isBehindViewportLayer(element: Element): boolean {
  const host = element.closest(`[${VIEWPORT_LAYER_ATTRIBUTE}]`);
  if (!host) return false;
  if (isCoveredByViewportLayer(host)) return true;
  return Array.from(host.querySelectorAll(`[${VIEWPORT_LAYER_ATTRIBUTE}]`)).some(
    (layer) => !layer.contains(element)
  );
}

/**
 * {@link isBehindViewportLayer}, plus the case it leaves out (Issue #3700): an
 * `element` with no viewport layer of its own around it — the PC file panel's
 * search bar while the file is not maximized. It is behind any viewport layer
 * drawn over the root-level box it sits in: one with a z-index is compared by
 * {@link isCoveredByViewportLayer}; the page itself (no z-index) is under
 * every viewport layer showing, such as the editor's CSS maximize in the same
 * panel.
 */
export function isUnderViewportLayer(element: Element): boolean {
  if (element.closest(`[${VIEWPORT_LAYER_ATTRIBUTE}]`)) return isBehindViewportLayer(element);
  let root: Element = element;
  while (root.parentElement && root.parentElement !== document.body) root = root.parentElement;
  if (stackOrder(root) !== null) return isCoveredByViewportLayer(root);
  return document.querySelector(`[${VIEWPORT_LAYER_ATTRIBUTE}]`) !== null;
}
