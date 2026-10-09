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
 * The History pane was moved into each PC terminal split (1-4 splits since
 * Issue #2421; 1-3 when this was written). Because
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
 * Static `::highlight()` CSS rules for `history-search-0|1|2|3` and
 * `history-search-current-0|1|2|3` are defined in `src/app/globals.css`
 * (MAX_SPLITS=4 since Issue #2421, see `src/config/terminal-split-config.ts`).
 * The rule list is the hard bound on the split count: a namespace with no rule
 * still registers matches and still scrolls to them, it just paints nothing, so
 * raising MAX_SPLITS without extending globals.css breaks search in the LAST
 * split silently.
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
 * [Issue #3503] Marks a subtree whose text is drawn for the eye only — a mermaid
 * diagram's SVG (its `<style>` and labels), the loading / error text around it,
 * and the "Source" summary. Search counts none of it: none of it is in the
 * message as written.
 */
export const SEARCH_SKIP_ATTR = 'data-search-skip';

/**
 * [Issue #3503] Marks the element holding a mermaid block's source, verbatim.
 * The one place a hit inside a ```mermaid fence can be shown once the fence is
 * drawn as a diagram.
 */
export const MERMAID_SOURCE_ATTR = 'data-mermaid-source';

/**
 * [Issue #3503] Fired (bubbling) from a mermaid block whenever its diagram
 * finishes drawing or fails. The diagram is drawn late — a dynamic import, an
 * async render, and again on a theme switch — so a search highlighter listens
 * for it and re-applies, rather than keeping the current-match overlay placed
 * for the height the row had before (see `useHighlightReapplyTick`).
 */
export const MERMAID_BLOCK_SETTLED_EVENT = 'commandmate:mermaid-block-settled';

type TextNodeEntry = { node: Text; start: number; end: number };

/**
 * Collect text nodes with cumulative offsets from a container element.
 * Subtrees marked {@link SEARCH_SKIP_ATTR} are left out entirely.
 */
function collectTextNodes(container: Element): TextNodeEntry[] {
  const textNodes: TextNodeEntry[] = [];
  let offset = 0;
  const walker = document.createTreeWalker(
    container,
    NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT,
    {
      acceptNode(node) {
        if (node.nodeType === Node.TEXT_NODE) return NodeFilter.FILTER_ACCEPT;
        return (node as Element).hasAttribute(SEARCH_SKIP_ATTR)
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_SKIP;
      },
    },
  );
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const text = node as Text;
    const len = text.nodeValue?.length ?? 0;
    textNodes.push({ node: text, start: offset, end: offset + len });
    offset += len;
  }
  return textNodes;
}

/** One ```mermaid fence in the raw text, by offset. */
export interface MermaidFence {
  /** Start of the opening fence line. */
  fenceStart: number;
  /** Start of the first body line. */
  bodyStart: number;
  /** End of the last body line (its newline excluded). */
  bodyEnd: number;
  /** End of the closing fence line (or of the text, if the fence never closes). */
  fenceEnd: number;
  /** The body as Markdown reads it — what the source element shows. */
  body: string;
}

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * [Issue #3503] Find the ```mermaid fences in a Markdown string. Other fences are
 * tracked only so a ```mermaid line inside them is not mistaken for an opener.
 */
export function findMermaidFences(text: string): MermaidFence[] {
  const fences: MermaidFence[] = [];
  const lines: Array<{ start: number; end: number; next: number }> = [];
  let cursor = 0;
  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor);
    const end = nl === -1 ? text.length : nl;
    lines.push({ start: cursor, end, next: nl === -1 ? text.length : nl + 1 });
    if (nl === -1) break;
    cursor = nl + 1;
  }

  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(text.slice(lines[i].start, lines[i].end));
    if (!open) continue;
    const marker = open[1];
    const info = open[2].trim();
    if (marker[0] === '`' && info.includes('`')) continue; // not a fence
    const closeRe = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}[ \\t]*$`);
    let close = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (closeRe.test(text.slice(lines[j].start, lines[j].end))) {
        close = j;
        break;
      }
    }
    const lastBody = close === -1 ? lines.length - 1 : close - 1;
    if (info.split(/[ \t]/)[0] === 'mermaid') {
      const bodyStart = lines[i].next;
      const bodyEnd = lastBody > i ? lines[lastBody].end : bodyStart;
      fences.push({
        fenceStart: lines[i].start,
        bodyStart,
        bodyEnd,
        fenceEnd: close === -1 ? text.length : lines[close].end,
        body: text.slice(bodyStart, bodyEnd),
      });
    }
    i = close === -1 ? lines.length : close;
  }
  return fences;
}

/** Offsets of every (overlapping) occurrence of `needle` in `haystack`. */
function occurrences(haystack: string, needle: string): number[] {
  const found: number[] = [];
  if (!needle) return found;
  let cursor = 0;
  while (true) {
    const idx = haystack.indexOf(needle, cursor);
    if (idx === -1) return found;
    found.push(idx);
    cursor = idx + 1;
  }
}

/**
 * [Issue #3503] Translate offsets into the raw message text to offsets into the
 * container's (skip-filtered) text, for a message whose mermaid fences are drawn
 * as diagrams with their source folded underneath.
 *
 * The raw text and the DOM no longer line up there: the fence lines are not
 * drawn, the diagram is not counted, and a "Source" summary is not counted
 * either. So the text is cut at each fence that has a source element on screen
 * (paired by equal body, in order):
 *
 * - a hit inside a fence body maps to the same offset inside that body's source
 *   element — the body is shown verbatim;
 * - a hit between fences is the n-th occurrence of its text in that stretch of
 *   raw text, and maps to the n-th occurrence of the same text in the matching
 *   stretch of the DOM — which survives whatever Markdown syntax the stretch has;
 * - a hit on a fence line (```mermaid itself) has nothing on screen: `null`.
 *
 * A fence that could not be paired (one inside a blockquote, say, whose raw
 * lines carry `> `) is simply part of a stretch, and its hits still land on its
 * source by occurrence.
 *
 * Returns `null` when the container shows no mermaid source at all, so the
 * caller keeps the plain offset-equals-offset behaviour every other message has.
 */
function mapRawPositionsToDom(
  container: Element,
  textNodes: TextNodeEntry[],
  sourceText: string,
  positions: MatchPosition[],
): Array<MatchPosition | null> | null {
  const sourceElements = Array.from(container.querySelectorAll(`[${MERMAID_SOURCE_ATTR}]`));
  if (sourceElements.length === 0) return null;
  const fences = findMermaidFences(sourceText);

  const domText = textNodes.map((entry) => entry.node.nodeValue ?? '').join('');
  const pairs: Array<{ fence: MermaidFence; domStart: number; domEnd: number }> = [];
  let fenceCursor = 0;
  for (const element of sourceElements) {
    const inside = textNodes.filter((entry) => element.contains(entry.node));
    if (inside.length === 0) continue;
    const domStart = inside[0].start;
    const domEnd = inside[inside.length - 1].end;
    const shown = domText.slice(domStart, domEnd);
    for (let k = fenceCursor; k < fences.length; k++) {
      if (fences[k].body === shown) {
        pairs.push({ fence: fences[k], domStart, domEnd });
        fenceCursor = k + 1;
        break;
      }
    }
  }

  // Stretches of raw text between paired fences, each with its DOM counterpart.
  const gaps: Array<{ rawStart: number; rawEnd: number; domStart: number; domEnd: number }> = [];
  let rawStart = 0;
  let domStart = 0;
  for (const pair of pairs) {
    gaps.push({ rawStart, rawEnd: pair.fence.fenceStart, domStart, domEnd: pair.domStart });
    rawStart = pair.fence.fenceEnd;
    domStart = pair.domEnd;
  }
  gaps.push({ rawStart, rawEnd: sourceText.length, domStart, domEnd: domText.length });

  const lowerRaw = sourceText.toLowerCase();
  const lowerDom = domText.toLowerCase();

  return positions.map((pos) => {
    const length = pos.end - pos.start;
    const pair = pairs.find((p) => pos.start >= p.fence.fenceStart && pos.start < p.fence.fenceEnd);
    if (pair) {
      const { bodyStart, bodyEnd } = pair.fence;
      if (pos.start < bodyStart || pos.start >= bodyEnd) return null;
      const start = pair.domStart + (pos.start - bodyStart);
      return { start, end: Math.min(start + length, pair.domEnd) };
    }
    const gap = gaps.find((g) => pos.start >= g.rawStart && pos.start < g.rawEnd);
    if (!gap) return null;
    const needle = lowerRaw.slice(pos.start, pos.end);
    const ordinal = occurrences(lowerRaw.slice(gap.rawStart, gap.rawEnd), needle).indexOf(
      pos.start - gap.rawStart,
    );
    const onScreen = occurrences(lowerDom.slice(gap.domStart, gap.domEnd), needle);
    if (ordinal === -1 || ordinal >= onScreen.length) return null;
    const start = gap.domStart + onScreen[ordinal];
    return { start, end: start + length };
  });
}

/**
 * [Issue #3503] A hit inside a folded mermaid source is shown by unfolding it.
 * Only a `<details>` that holds a mermaid source is opened — nothing else the
 * container happens to fold.
 */
function openFoldedSource(range: Range, container: Element): void {
  const start = range.startContainer;
  const element = start.nodeType === Node.TEXT_NODE ? start.parentElement : (start as Element);
  const details = element?.closest('details');
  if (
    details instanceof HTMLDetailsElement &&
    !details.open &&
    container.contains(details) &&
    details.querySelector(`[${MERMAID_SOURCE_ATTR}]`)
  ) {
    details.open = true;
  }
}

/**
 * Create a Range for a given [posStart, posEnd) span across text nodes.
 */
function buildRange(
  textNodes: TextNodeEntry[],
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

/**
 * [Issue #3503] Optional input for a highlight call.
 */
export interface HighlightOptions {
  /**
   * The raw text `matchPositions` index into. Given for a message rendered as
   * Markdown, so hits around and inside mermaid diagrams can be placed (see
   * `mapRawPositionsToDom`). Without it, offsets are DOM offsets as before.
   */
  sourceText?: string;
}

function applyHighlightsInternal(
  container: Element,
  matchPositions: MatchPosition[],
  currentIndex: number,
  namespace: HighlightNamespace,
  options?: HighlightOptions
): void {
  if (matchPositions.length === 0) {
    clearHighlightsInternal(namespace);
    return;
  }

  const textNodes = collectTextNodes(container);
  const positions: Array<MatchPosition | null> =
    (options?.sourceText !== undefined
      ? mapRawPositionsToDom(container, textNodes, options.sourceText, matchPositions)
      : null) ?? matchPositions;
  const ranges = positions.map((pos) => (pos ? buildRange(textNodes, pos.start, pos.end) : null));
  ranges.forEach((range) => {
    if (range) openFoldedSource(range, container);
  });

  // Build current match range (always needed for scrolling/overlay)
  const currentRange = ranges[currentIndex] ?? null;

  if (isCSSHighlightSupported()) {
    const allRanges: Range[] = [];

    ranges.forEach((range, idx) => {
      if (idx === currentIndex) return;
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
 * @param options - [Issue #3503] Optional. `sourceText` is the message as
 *   written; pass it for a Markdown body so hits inside / after mermaid
 *   diagrams land on the folded source and the right text.
 */
export function applyHistoryHighlights(
  container: Element,
  matchPositions: MatchPosition[],
  currentIndex: number,
  namespace: HighlightNamespace = HISTORY_SEARCH_NAMESPACE,
  options?: HighlightOptions
): void {
  applyHighlightsInternal(container, matchPositions, currentIndex, namespace, options);
}
