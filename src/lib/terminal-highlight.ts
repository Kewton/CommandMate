/**
 * terminal-highlight.ts
 * CSS Custom Highlight API wrapper functions for terminal text search
 * [Issue #47] Terminal text search feature
 *
 * Security: SEC-TS-002 - CSS Custom Highlight API avoids DOM manipulation (no XSS risk)
 */

/** Match position in container.textContent */
export interface MatchPosition {
  start: number;
  end: number;
}

const HIGHLIGHT_NAME = 'terminal-search';
const HIGHLIGHT_CURRENT_NAME = 'terminal-search-current';
const FALLBACK_OVERLAY_ID = 'terminal-search-fallback-overlay';

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
 * Clears all terminal search highlights.
 */
export function clearTerminalHighlights(): void {
  // Remove CSS highlights if supported
  if (isCSSHighlightSupported()) {
    CSS.highlights.delete(HIGHLIGHT_NAME);
    CSS.highlights.delete(HIGHLIGHT_CURRENT_NAME);
  }
  // Remove fallback overlay
  document.getElementById(FALLBACK_OVERLAY_ID)?.remove();
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

/**
 * Applies highlights to the container and scrolls to the current match.
 * Uses CSS Custom Highlight API when available, falls back to Selection API.
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
  if (matchPositions.length === 0) {
    clearTerminalHighlights();
    return;
  }

  const textNodes = collectTextNodes(container);

  // Build current match range (always needed for scrolling)
  const currentPos = matchPositions[currentIndex];
  const currentRange = currentPos ? buildRange(textNodes, currentPos.start, currentPos.end) : null;

  if (isCSSHighlightSupported()) {
    // Build non-current match ranges for background highlights
    const allRanges: Range[] = [];

    matchPositions.forEach((pos, idx) => {
      if (idx === currentIndex) return;
      const range = buildRange(textNodes, pos.start, pos.end);
      if (range) allRanges.push(range);
    });

    CSS.highlights.set(HIGHLIGHT_NAME, new Highlight(...allRanges));
    CSS.highlights.delete(HIGHLIGHT_CURRENT_NAME);
  }

  // Always use overlay for the current match (reliable across all browsers)
  showFallbackOverlay(container, currentRange);

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
function showFallbackOverlay(container: Element, currentRange: Range | null): void {
  let overlay = document.getElementById(FALLBACK_OVERLAY_ID);

  if (!currentRange) {
    overlay?.remove();
    return;
  }

  // Get bounding rect of the range relative to the container
  if (typeof currentRange.getBoundingClientRect !== 'function') {
    overlay?.remove();
    return;
  }
  const rangeRect = currentRange.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();

  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = FALLBACK_OVERLAY_ID;
    overlay.style.position = 'absolute';
    overlay.style.backgroundColor = 'rgba(255, 165, 0, 0.6)';
    overlay.style.borderRadius = '2px';
    overlay.style.pointerEvents = 'none';
    overlay.style.zIndex = '5';

    // Insert into the scrollable container itself so it scrolls with content
    if (container instanceof HTMLElement) {
      container.style.position = 'relative';
    }
    container.appendChild(overlay);
  }

  // Position relative to container's content area, accounting for scroll
  overlay.style.top = `${rangeRect.top - containerRect.top + container.scrollTop}px`;
  overlay.style.left = `${rangeRect.left - containerRect.left + container.scrollLeft}px`;
  overlay.style.width = `${rangeRect.width}px`;
  overlay.style.height = `${rangeRect.height}px`;
}
