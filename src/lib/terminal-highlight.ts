/**
 * terminal-highlight.ts
 * CSS Custom Highlight API wrapper functions for text search highlighting.
 *
 * [Issue #47] Terminal text search feature (original)
 * [Issue #716] History text search support via namespace abstraction.
 *   - Existing applyTerminalHighlights / clearTerminalHighlights signatures are
 *     preserved exactly (OCP: no changes to existing callers).
 *   - New applyHistoryHighlights / clearHistoryHighlights are added as thin
 *     wrappers that re-use the internal implementation.
 *
 * Security: SEC-TS-002 - CSS Custom Highlight API avoids DOM manipulation (no XSS risk)
 */

/** Match position in container.textContent */
export interface MatchPosition {
  start: number;
  end: number;
}

/**
 * [Issue #716] Highlight namespace abstraction.
 * Encapsulates the per-context constants used by the internal highlight engine.
 */
export interface HighlightNamespace {
  /** CSS Custom Highlight API name for non-current matches (e.g. 'terminal-search') */
  highlightName: string;
  /** CSS Custom Highlight API name for the currently focused match */
  currentHighlightName: string;
  /** DOM id used for the fallback overlay element */
  fallbackOverlayId: string;
  /**
   * Background color used by the fallback overlay. Each namespace gets a
   * visually distinct color so that the terminal and history search overlays
   * can coexist on the same page (terminal=orange, history=blue).
   */
  fallbackOverlayBgColor: string;
}

const TERMINAL_SEARCH_NAMESPACE: HighlightNamespace = {
  highlightName: 'terminal-search',
  currentHighlightName: 'terminal-search-current',
  fallbackOverlayId: 'terminal-search-fallback-overlay',
  fallbackOverlayBgColor: 'rgba(255, 165, 0, 0.6)',
};

/**
 * [Issue #716] Public namespace constant for the History search context.
 * Exported so that consumers (HistoryPane) can identify the namespace if needed.
 */
export const HISTORY_SEARCH_NAMESPACE: HighlightNamespace = {
  highlightName: 'history-search',
  currentHighlightName: 'history-search-current',
  fallbackOverlayId: 'history-search-fallback-overlay',
  fallbackOverlayBgColor: 'rgba(59, 130, 246, 0.6)',
};

/**
 * [Issue #744] Per-split History search namespace factory.
 *
 * The History pane was moved into each PC terminal split (1-3 splits). Because
 * the CSS Custom Highlight registry (`CSS.highlights`) is a single global Map
 * keyed by name, two simultaneously-mounted HistoryPanes that both used the
 * shared `HISTORY_SEARCH_NAMESPACE` would call
 * `CSS.highlights.set('history-search', ...)` and clobber each other's matches.
 *
 * `makeHistoryNamespace(splitIndex)` returns a namespace whose names are
 * suffixed with the split index (`history-search-0`, `history-search-current-0`,
 * `history-search-fallback-overlay-0`, ...) so each split's highlights live
 * under a distinct registry key and never overwrite one another.
 *
 * Static `::highlight()` CSS rules for `history-search-0|1|2` and
 * `history-search-current-0|1|2` are defined in `src/app/globals.css`
 * (MAX_SPLITS=3, see `src/config/terminal-split-config.ts`).
 *
 * The blue fallback color is intentionally identical to
 * `HISTORY_SEARCH_NAMESPACE` so all history splits look the same.
 */
export function makeHistoryNamespace(splitIndex: number): HighlightNamespace {
  return {
    highlightName: `history-search-${splitIndex}`,
    currentHighlightName: `history-search-current-${splitIndex}`,
    fallbackOverlayId: `history-search-fallback-overlay-${splitIndex}`,
    fallbackOverlayBgColor: HISTORY_SEARCH_NAMESPACE.fallbackOverlayBgColor,
  };
}

/**
 * Returns true if CSS Custom Highlight API is available in this browser.
 * SEC-TS-002: Used to provide XSS-safe highlighting without DOM modification.
 */
export function isCSSHighlightSupported(): boolean {
  return (
    typeof CSS !== 'undefined' &&
    CSS !== null &&
    'highlights' in CSS
  );
}

/**
 * Collect text nodes with cumulative offsets from a container element.
 */
function collectTextNodes(container: Element): Array<{ node: Text; start: number; end: number }> {
  const textNodes: Array<{ node: Text; start: number; end: number }> = [];
  let offset = 0;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    const len = node.nodeValue?.length ?? 0;
    textNodes.push({ node, start: offset, end: offset + len });
    offset += len;
  }
  return textNodes;
}

/**
 * Create a Range for a given [posStart, posEnd) span across text nodes.
 */
function buildRange(
  textNodes: Array<{ node: Text; start: number; end: number }>,
  posStart: number,
  posEnd: number
): Range | null {
  const range = document.createRange();
  let startSet = false;

  for (const { node, start, end } of textNodes) {
    if (!startSet && posStart < end && posStart >= start) {
      range.setStart(node, posStart - start);
      startSet = true;
    }
    if (startSet && posEnd <= end) {
      range.setEnd(node, posEnd - start);
      return range;
    }
  }
  return startSet ? range : null;
}

// ============================================================================
// Internal namespace-aware implementations
// ============================================================================

function clearHighlightsInternal(namespace: HighlightNamespace): void {
  if (isCSSHighlightSupported()) {
    CSS.highlights.delete(namespace.highlightName);
    CSS.highlights.delete(namespace.currentHighlightName);
  }
  document.getElementById(namespace.fallbackOverlayId)?.remove();
}

function applyHighlightsInternal(
  container: Element,
  matchPositions: MatchPosition[],
  currentIndex: number,
  namespace: HighlightNamespace
): void {
  if (matchPositions.length === 0) {
    clearHighlightsInternal(namespace);
    return;
  }

  const textNodes = collectTextNodes(container);

  // Build current match range (always needed for scrolling/overlay)
  const currentPos = matchPositions[currentIndex];
  const currentRange = currentPos ? buildRange(textNodes, currentPos.start, currentPos.end) : null;

  if (isCSSHighlightSupported()) {
    const allRanges: Range[] = [];

    matchPositions.forEach((pos, idx) => {
      if (idx === currentIndex) return;
      const range = buildRange(textNodes, pos.start, pos.end);
      if (range) allRanges.push(range);
    });

    CSS.highlights.set(namespace.highlightName, new Highlight(...allRanges));
    CSS.highlights.delete(namespace.currentHighlightName);
  }

  // Always use overlay for the current match (reliable across all browsers)
  showFallbackOverlay(container, currentRange, namespace);

  // Scroll current match into view
  if (currentRange) {
    const startNode = currentRange.startContainer;
    const el = startNode.nodeType === Node.TEXT_NODE ? startNode.parentElement : startNode as Element;
    if (el && typeof el.scrollIntoView === 'function') {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }
}

/**
 * Fallback highlight: positions a bright overlay div over the current match.
 * No DOM content modification — only adds/moves an absolute-positioned overlay.
 */
function showFallbackOverlay(
  container: Element,
  currentRange: Range | null,
  namespace: HighlightNamespace
): void {
  let overlay = document.getElementById(namespace.fallbackOverlayId);

  if (!currentRange) {
    overlay?.remove();
    return;
  }

  if (typeof currentRange.getBoundingClientRect !== 'function') {
    overlay?.remove();
    return;
  }
  const rangeRect = currentRange.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = namespace.fallbackOverlayId;
    overlay.style.position = 'absolute';
    overlay.style.backgroundColor = namespace.fallbackOverlayBgColor;
    overlay.style.borderRadius = '2px';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '5';

    if (container instanceof HTMLElement) {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
  } else {
    // Keep background color in sync with the namespace (defensive)
    overlay.style.backgroundColor = namespace.fallbackOverlayBgColor;
  }

  overlay.style.top = `${rangeRect.top - containerRect.top + container.scrollTop}px`;
  overlay.style.left = `${rangeRect.left - containerRect.left + container.scrollLeft}px`;
  overlay.style.width = `${rangeRect.width}px`;
  overlay.style.height = `${rangeRect.height}px`;
}

// ============================================================================
// Public API: Terminal search (Issue #47, signatures preserved)
// ============================================================================

/**
 * Clears all terminal search highlights.
 */
export function clearTerminalHighlights(): void {
  clearHighlightsInternal(TERMINAL_SEARCH_NAMESPACE);
}

/**
 * Applies highlights to the container and scrolls to the current match
 * using the terminal-search namespace.
 *
 * @param container - The DOM element containing the terminal output
 * @param matchPositions - Array of {start, end} positions in container.textContent
 * @param currentIndex - Index of the currently focused match
 *
 * Security: SEC-TS-002 - No DOM modification, highlighting via browser APIs only
 */
export function applyTerminalHighlights(
  container: Element,
  matchPositions: MatchPosition[],
  currentIndex: number
): void {
  applyHighlightsInternal(container, matchPositions, currentIndex, TERMINAL_SEARCH_NAMESPACE);
}

// ============================================================================
// Public API: History search (Issue #716)
// ============================================================================

/**
 * Clears all history search highlights for the given namespace.
 *
 * Does not affect terminal-search highlights — namespaces are independent.
 *
 * [Issue #744] Accepts an optional `namespace` (e.g. from
 * `makeHistoryNamespace(splitIndex)`) so per-split HistoryPanes can clear only
 * their own highlights. Defaults to the legacy `HISTORY_SEARCH_NAMESPACE` for
 * backward compatibility (mobile / single-pane callers pass no argument).
 */
export function clearHistoryHighlights(
  namespace: HighlightNamespace = HISTORY_SEARCH_NAMESPACE
): void {
  clearHighlightsInternal(namespace);
}

/**
 * Applies highlights to a per-message container using the history-search namespace.
 * Re-uses the same internal engine as applyTerminalHighlights but with a
 * distinct namespace (and a blue fallback color) so the two search bars can
 * coexist on the same page.
 *
 * @param container - The DOM element whose textContent should be highlighted
 * @param matchPositions - Array of {start, end} positions in container.textContent
 * @param currentIndex - Index of the currently focused match (use -1 to skip current)
 * @param namespace - [Issue #744] Optional per-split namespace (from
 *   `makeHistoryNamespace(splitIndex)`). Defaults to the legacy
 *   `HISTORY_SEARCH_NAMESPACE` so existing single-pane / mobile callers are
 *   unaffected. Passing a per-split namespace prevents simultaneously-mounted
 *   HistoryPanes from clobbering each other's CSS.highlights entries.
 */
export function applyHistoryHighlights(
  container: Element,
  matchPositions: MatchPosition[],
  currentIndex: number,
  namespace: HighlightNamespace = HISTORY_SEARCH_NAMESPACE
): void {
  applyHighlightsInternal(container, matchPositions, currentIndex, namespace);
}
